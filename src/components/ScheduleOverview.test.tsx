import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ScheduleOverview } from './ScheduleOverview'
import { Event } from '../types/event'

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: null })),
}))
vi.mock('../services/weatherService', () => ({
  getTodayWeather: vi.fn(async () => null),
}))
vi.mock('../services/profileService', () => ({
  getLocations: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/practiceService', () => ({
  listPractices: vi.fn(async () => []),
  completionsThisWeek: vi.fn(async () => []),
  markPracticeDone: vi.fn(async () => {}),
  unmarkPracticeDone: vi.fn(async () => {}),
}))
// Stub the reused timeline card — exercised in its own test. Expose
// Edit/Delete/ToggleTodo so we can assert the reveal wires actions.
vi.mock('./EventCard', () => ({
  EventCard: ({
    event,
    onEdit,
    onDelete,
    onToggleTodo,
  }: {
    event: Event
    onEdit?: (e: Event) => void
    onDelete?: (id: string) => void
    onToggleTodo?: (e: Event) => void
  }) => (
    <div data-testid="event-card">
      <span>Card: {event.title}</span>
      {onEdit && <button type="button" onClick={() => onEdit(event)}>Edit event</button>}
      {onDelete && <button type="button" onClick={() => onDelete(event.id)}>Delete event</button>}
      {onToggleTodo && <button type="button" onClick={() => onToggleTodo(event)}>Toggle todo</button>}
    </div>
  ),
}))
// CalendarGrid pulls heavy deps; stub to a marker.
vi.mock('./CalendarGrid', () => ({
  CalendarGrid: () => <div data-testid="calendar-grid" />,
}))
vi.mock('../services/eventService', () => ({
  completeTodo: vi.fn(async () => ({ data: {}, error: null })),
  uncompleteTodo: vi.fn(async () => ({ data: {}, error: null })),
  convertEventKind: vi.fn(async () => ({ data: {}, error: null })),
}))

function renderOverview(events: Event[] = [], onEdit = vi.fn()) {
  return render(
    <MemoryRouter>
      <ScheduleOverview
        events={events}
        onEdit={onEdit}
        onDelete={vi.fn()}
        onShareSuccess={vi.fn()}
        onHashtagClick={vi.fn()}
        preferredVisitDates={{}}
      />
    </MemoryRouter>
  )
}

function makeEvent(overrides: Partial<Event>): Event {
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: overrides.id ?? 'e1', title: 'Untitled', description: null,
    start_date: today, end_date: null,
    enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
    image_url: null, location: null, hashtags: null,
    event_kind: 'event', event_type: 'personal', event_status: 'going',
    created_by: 'u1', created_at: today, updated_at: today,
    shared_with_friends: 'none', ...overrides,
  } as Event
}

// Wednesday of the current week — always inside the rendered Mon–Sun window.
function midWeekIso(): string {
  const d = new Date()
  const dow = d.getDay() || 7
  d.setDate(d.getDate() - (dow - 1) + 2)
  return d.toISOString().slice(0, 10)
}

const todayIso = () => new Date().toISOString().slice(0, 10)

function daysAgoIso(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

describe('ScheduleOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the schedule sections (no separate Today card)', () => {
    renderOverview([])
    expect(screen.getByText('Your Schedule')).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
    expect(screen.queryByText('Today')).not.toBeInTheDocument()
  })

  it('renders the header date', () => {
    renderOverview([])
    expect(screen.getAllByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d+$/).length)
      .toBeGreaterThanOrEqual(1)
  })

  it('reads weather for the default location', async () => {
    const { getLocations } = await import('../services/profileService')
    const { getTodayWeather } = await import('../services/weatherService')
    vi.mocked(getLocations).mockResolvedValue({
      data: [{ id: 'l', user_id: 'u', label: 'Home', address: '', city: 'Ghent', country: 'BE', is_default: true }],
      error: null,
    })
    renderOverview([])
    await vi.waitFor(() => {
      expect(vi.mocked(getTodayWeather)).toHaveBeenCalledWith('Ghent')
    })
  })

  it('renders compact weather (temp + summary) next to the heading', async () => {
    const { getTodayWeather } = await import('../services/weatherService')
    vi.mocked(getTodayWeather).mockResolvedValue({
      city: 'Brussels', temp_c: 24, summary: 'clear', chips: [], fetched_at: new Date().toISOString(),
    })
    renderOverview([])
    expect(await screen.findByText(/24°\s*clear/)).toBeInTheDocument()
  })

  it('lists practices and toggles completion', async () => {
    const { listPractices, completionsThisWeek, markPracticeDone } = await import('../services/practiceService')
    vi.mocked(listPractices).mockResolvedValue([
      { id: 'p1', name: 'Sunscreen', recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null } as never,
      { id: 'p2', name: 'Gym', recurrence_mode: 'flex_count', recurrence_rule: null, flex_period: 'week', flex_target: 3 } as never,
    ])
    vi.mocked(completionsThisWeek).mockResolvedValue([])
    renderOverview([])
    expect(await screen.findByText(/Sunscreen \(daily\)/)).toBeInTheDocument()
    expect(screen.getByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()
    screen.getAllByRole('checkbox')[0].click()
    expect(vi.mocked(markPracticeDone)).toHaveBeenCalledWith('p1', expect.any(String))
  })

  it('renders a today event inside the week card', () => {
    renderOverview([makeEvent({ id: 'e1', title: 'Weekly call', start_date: todayIso() })])
    const week = screen.getByTestId('week-card')
    expect(within(week).getByText('Weekly call')).toBeInTheDocument()
  })

  it('renders a reminder in the week with a tag', () => {
    renderOverview([makeEvent({ id: 'r1', title: 'Renew books', event_kind: 'reminder', start_date: midWeekIso() })])
    const week = screen.getByTestId('week-card')
    expect(within(week).getByText('Renew books')).toBeInTheDocument()
    expect(within(week).getByText('reminder')).toBeInTheDocument()
  })

  it('lists upcoming month events in the sidebar and excludes reminders', () => {
    const today = new Date()
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const day = Math.min(today.getDate() + 1, lastDay)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const iso = `${thisMonth}-${String(day).padStart(2, '0')}`
    renderOverview([
      makeEvent({ id: 'm1', title: 'Camp deadline', start_date: iso }),
      makeEvent({ id: 'mr', title: 'Renew passport', event_kind: 'reminder', start_date: iso }),
    ])
    const monthList = screen.getByTestId('month-list')
    expect(within(monthList).getByText('Camp deadline')).toBeInTheDocument()
    expect(within(monthList).queryByText('Renew passport')).not.toBeInTheDocument()
  })

  it('marks today in the month list', () => {
    renderOverview([makeEvent({ id: 'mt', title: 'Camp deadline', start_date: todayIso() })])
    const monthList = screen.getByTestId('month-list')
    expect(within(monthList).getByText('Camp deadline')).toBeInTheDocument()
    expect(within(monthList).getByText('today')).toBeInTheDocument()
  })

  it('hides cancelled events', () => {
    renderOverview([
      makeEvent({ id: 'c1', title: 'Cancelled today', start_date: todayIso(), event_status: 'cancelled' }),
    ])
    expect(screen.queryByText('Cancelled today')).not.toBeInTheDocument()
  })

  it('flags overlapping events with an overlaps tag in the week', () => {
    const day = todayIso()
    renderOverview([
      makeEvent({ id: 'o1', title: 'Check with Pidpa', start_date: `${day}T11:00:00`, end_date: `${day}T12:00:00` }),
      makeEvent({ id: 'o2', title: 'Dentist', start_date: `${day}T11:30:00`, end_date: `${day}T12:30:00` }),
    ])
    const week = screen.getByTestId('week-card')
    expect(within(week).getAllByText(/overlaps/)).toHaveLength(2)
  })

  it('clicking a row reveals the reused EventCard, whose Edit enters edit mode', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const event = makeEvent({ id: 'e9', title: 'Weekly call', start_date: todayIso() })
    renderOverview([event], onEdit)
    const week = screen.getByTestId('week-card')
    expect(within(week).queryByTestId('quick-event-card')).not.toBeInTheDocument()
    await user.click(within(week).getByText('Weekly call'))
    expect(within(week).getByTestId('quick-event-card')).toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
    await user.click(within(week).getByText('Edit event'))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'e9' }))
  })

  it('clicking a month-list entry reveals the reused EventCard there', async () => {
    const user = userEvent.setup()
    const today = new Date()
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const day = Math.min(today.getDate() + 1, lastDay)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const iso = `${thisMonth}-${String(day).padStart(2, '0')}`
    renderOverview([makeEvent({ id: 'm9', title: 'Camp deadline', start_date: iso })])
    const monthList = screen.getByTestId('month-list')
    expect(within(monthList).queryByTestId('quick-event-card')).not.toBeInTheDocument()
    await user.click(within(monthList).getByText('Camp deadline'))
    expect(within(monthList).getByTestId('quick-event-card')).toBeInTheDocument()
  })

  it('has no Overdue section when there are no overdue to-dos', () => {
    renderOverview([makeEvent({ id: 't1', title: 'Buy groceries', event_kind: 'todo', start_date: midWeekIso() })])
    expect(screen.queryByTestId('overdue-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument()
  })

  it('shows past incomplete to-dos in an Overdue section above the week', () => {
    renderOverview([
      makeEvent({ id: 'od1', title: 'Renew permit', event_kind: 'todo', start_date: daysAgoIso(3) }),
    ])
    const overdue = screen.getByTestId('overdue-card')
    expect(within(overdue).getByText('Renew permit')).toBeInTheDocument()
    // Not duplicated in the week list.
    const week = screen.getByTestId('week-card')
    expect(within(week).queryByText('Renew permit')).not.toBeInTheDocument()
  })

  it('excludes completed and non-todo past events from Overdue', () => {
    renderOverview([
      makeEvent({ id: 'done', title: 'Done task', event_kind: 'todo', start_date: daysAgoIso(2), completed_at: daysAgoIso(1) }),
      makeEvent({ id: 'evt', title: 'Past meeting', event_kind: 'event', start_date: daysAgoIso(2) }),
    ])
    expect(screen.queryByTestId('overdue-card')).not.toBeInTheDocument()
  })

  it('a today to-do is not overdue', () => {
    renderOverview([makeEvent({ id: 'tt', title: 'Today task', event_kind: 'todo', start_date: todayIso() })])
    expect(screen.queryByTestId('overdue-card')).not.toBeInTheDocument()
  })

  it('checking an overdue to-do calls completeTodo', async () => {
    const user = userEvent.setup()
    const { completeTodo } = await import('../services/eventService')
    renderOverview([
      makeEvent({ id: 'od9', title: 'Pay invoice', event_kind: 'todo', start_date: daysAgoIso(5) }),
    ])
    const overdue = screen.getByTestId('overdue-card')
    await user.click(within(overdue).getByRole('checkbox', { name: /mark done/i }))
    expect(vi.mocked(completeTodo)).toHaveBeenCalledWith('od9')
  })

  it('renders a checkbox for a todo in the week list', async () => {
    renderOverview([
      makeEvent({ id: 't1', title: 'Buy groceries', event_kind: 'todo', start_date: midWeekIso() }),
    ])
    const week = screen.getByTestId('week-card')
    expect(within(week).getByText('Buy groceries')).toBeInTheDocument()
    expect(within(week).getByText('to-do')).toBeInTheDocument()
    expect(
      await screen.findByRole('checkbox', { name: /mark (done|not done)/i })
    ).toBeInTheDocument()
  })

  it('excludes to-dos from the month-list sidebar (grid-only)', () => {
    const today = new Date()
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const day = Math.min(today.getDate() + 1, lastDay)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const iso = `${thisMonth}-${String(day).padStart(2, '0')}`
    renderOverview([
      makeEvent({ id: 'mevt', title: 'Camp deadline', start_date: iso }),
      makeEvent({ id: 'mtodo', title: 'Pick up package', event_kind: 'todo', start_date: iso }),
    ])
    const monthList = screen.getByTestId('month-list')
    expect(within(monthList).getByText('Camp deadline')).toBeInTheDocument()
    expect(within(monthList).queryByText('Pick up package')).not.toBeInTheDocument()
  })
})
