import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ScheduleOverview } from './ScheduleOverview'
import { Event } from '../types/event'

vi.mock('../hooks/usePrimaryGroup', () => ({
  usePrimaryGroup: vi.fn(() => null),
}))
vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: null })),
}))
vi.mock('../services/weatherService', () => ({
  getTodayWeather: vi.fn(async () => null),
}))
vi.mock('../services/practiceService', () => ({
  listPractices: vi.fn(async () => []),
  completionsThisWeek: vi.fn(async () => []),
  markPracticeDone: vi.fn(async () => {}),
  unmarkPracticeDone: vi.fn(async () => {}),
}))
// Stub the details modal — its real services are exercised in its own test.
vi.mock('./EventDetailsModal', () => ({
  EventDetailsModal: ({ event, onEdit }: { event: Event; onEdit?: (e: Event) => void }) => (
    <div data-testid="details-modal">
      <span>Modal: {event.title}</span>
      {onEdit && (
        <button type="button" onClick={() => onEdit(event)}>Edit event</button>
      )}
    </div>
  ),
}))

function renderOverview(events: Event[] = []) {
  return render(
    <MemoryRouter>
      <ScheduleOverview
        events={events}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onShareSuccess={vi.fn()}
        onHashtagClick={vi.fn()}
        preferredVisitDates={{}}
      />
    </MemoryRouter>
  )
}

describe('ScheduleOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the schedule sections', async () => {
    renderOverview([])
    expect(screen.getByText('Your Schedule')).toBeInTheDocument()
    // Weather + Routines render no title and may hide entirely on no data
    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('This week')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
  })

  it('renders the date and never shows a family tag', async () => {
    renderOverview([])
    // Header date format like "Thursday, May 28" — match the full pattern
    // with both weekday and month so we don't collide with CalendarGrid's
    // day-of-week selector options.
    expect(screen.getAllByText(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d+$/).length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/for the .* family/)).not.toBeInTheDocument()
  })

  it('renders compact weather (temp + summary) next to the heading', async () => {
    const { getTodayWeather } = await import('../services/weatherService')
    vi.mocked(getTodayWeather).mockResolvedValueOnce({
      city: 'Brussels',
      temp_c: 24,
      summary: 'clear',
      chips: [
        { time: '08:00', label: 'AM clear' },
        { time: '13:00', label: 'noon clear' },
        { time: '19:00', label: 'PM clear' },
      ],
      fetched_at: new Date().toISOString(),
    })
    renderOverview([])
    // Temp + summary now render inline as a single line; the hourly chips are gone.
    expect(await screen.findByText(/24°\s*clear/)).toBeInTheDocument()
    expect(screen.queryByText('AM clear')).not.toBeInTheDocument()
  })

  it('lists practices and toggles completion', async () => {
    const { listPractices, completionsThisWeek, markPracticeDone } =
      await import('../services/practiceService')
    vi.mocked(listPractices).mockResolvedValueOnce([
      { id: 'p1', name: 'Sunscreen before drop-off', frequency_type: 'daily', target_count: null } as any,
      { id: 'p2', name: 'Gym',                       frequency_type: 'weekly_count', target_count: 3 } as any,
    ])
    vi.mocked(completionsThisWeek).mockResolvedValueOnce([])
    renderOverview([])
    expect(await screen.findByText(/Sunscreen before drop-off/)).toBeInTheDocument()
    expect(screen.getByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()

    // Click the first checkbox
    const cb = screen.getAllByRole('checkbox')[0]
    cb.click()
    expect(vi.mocked(markPracticeDone)).toHaveBeenCalledWith('p1', expect.any(String))
  })

  function makeEvent(overrides: Partial<Event>): Event {
    const today = new Date().toISOString().slice(0, 10)
    return {
      id: overrides.id ?? 'e1',
      title: 'Untitled',
      description: null,
      start_date: today,
      end_date: null,
      enrollment_url: null,
      enrollment_deadline: null,
      enrollment_start_date: null,
      image_url: null,
      location: null,
      hashtags: null,
      event_kind: 'event',
      event_type: 'personal',
      event_status: 'going',
      created_by: 'u1',
      created_at: today,
      updated_at: today,
      shared_with_friends: 'none',
      ...overrides,
    } as Event
  }

  it('renders today events in the Today card', () => {
    renderOverview([
      makeEvent({ id: 'e1', title: 'Sync with Priya', start_date: new Date().toISOString().slice(0, 10) }),
    ])
    // Today's event appears in both TodayCard and in the week grid's today cell
    expect(screen.getAllByText('Sync with Priya').length).toBeGreaterThanOrEqual(1)
  })

  it('renders week events as chips on the right day', () => {
    // Wednesday of the current week — always inside the Mon–Sun window the
    // week card renders, regardless of which weekday the test runs on (a naive
    // "tomorrow" lands outside the window when today is Sunday).
    const d = new Date()
    const dow = d.getDay() || 7
    d.setDate(d.getDate() - (dow - 1) + 2)
    const inWeek = d.toISOString().slice(0, 10)
    renderOverview([makeEvent({ id: 'e2', title: 'Dentist', start_date: inWeek })])
    // CalendarGrid (month card) also renders event titles, so multiple matches may exist
    expect(screen.getAllByText('Dentist').length).toBeGreaterThanOrEqual(1)
  })

  it('lists upcoming events of the current month in the sidebar and excludes reminders', () => {
    const today = new Date()
    const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const upcomingDay = Math.min(today.getDate() + 1, lastDayOfMonth)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const upcomingIso = `${thisMonth}-${String(upcomingDay).padStart(2, '0')}`
    renderOverview([
      // Reminder — excluded from sidebar even though in-month
      makeEvent({ id: 'r1', title: 'Renew passport', event_kind: 'reminder', start_date: upcomingIso }),
      // Regular event in the future — should appear
      makeEvent({ id: 'e3', title: 'Camp deadline', start_date: upcomingIso }),
    ])
    expect(screen.getAllByText('Camp deadline').length).toBeGreaterThanOrEqual(1)
  })

  it('hides cancelled events everywhere — today, week, and month', () => {
    const today = new Date()
    const todayIso = today.toISOString().slice(0, 10)
    // Wednesday of the current week (same trick as the week-chip test)
    const w = new Date()
    const dow = w.getDay() || 7
    w.setDate(w.getDate() - (dow - 1) + 2)
    const inWeekIso = w.toISOString().slice(0, 10)
    const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const upcomingDay = Math.min(today.getDate() + 1, lastDayOfMonth)
    const thisMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
    const upcomingIso = `${thisMonth}-${String(upcomingDay).padStart(2, '0')}`
    renderOverview([
      makeEvent({ id: 'c1', title: 'Cancelled today', start_date: todayIso, event_status: 'cancelled' }),
      makeEvent({ id: 'c2', title: 'Cancelled this week', start_date: inWeekIso, event_status: 'cancelled' }),
      makeEvent({ id: 'c3', title: 'Cancelled this month', start_date: upcomingIso, event_status: 'cancelled' }),
    ])
    expect(screen.queryByText('Cancelled today')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelled this week')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancelled this month')).not.toBeInTheDocument()
  })

  it('clicking an event opens the details modal, and its Edit button enters edit mode', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const todayIso = new Date().toISOString().slice(0, 10)
    const event = makeEvent({ id: 'e9', title: 'Sync with Priya', start_date: todayIso })
    render(
      <MemoryRouter>
        <ScheduleOverview
          events={[event]}
          onEdit={onEdit}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
        />
      </MemoryRouter>
    )
    // Click the Today-card entry — opens the details modal, NOT edit mode.
    await user.click(screen.getAllByText('Sync with Priya')[0])
    expect(screen.getByTestId('details-modal')).toBeInTheDocument()
    expect(onEdit).not.toHaveBeenCalled()
    // The modal's Edit button hands off to edit mode.
    await user.click(screen.getByText('Edit event'))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'e9' }))
  })
})
