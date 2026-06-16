import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

// Format a Date as a full local ISO timestamp at midday, matching the
// `${day}T11:00:00` shape the timed-event fixtures use. Midday avoids any
// midnight tz-crossing flakiness.
function middayIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}T12:00:00`
}

// Another weekday in the SAME ISO week (Mon–Sun) as today, never today itself.
// Picks Tuesday unless today is Tuesday, in which case Thursday — both stay in-week.
function otherDayThisWeek(): Date {
  const d = new Date()
  const dow = d.getDay() || 7 // 1..7, Mon..Sun
  const target = dow === 2 ? 4 : 2 // Thursday if today is Tuesday, else Tuesday
  d.setDate(d.getDate() - (dow - target))
  return d
}

// A day in next ISO week: today + 7 lands on the same weekday one week out.
function nextWeekDay(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  return d
}

// A unified-recurrence PracticeRow fixture. `dtstart` sits well in the past so a
// pinned-daily routine is due on ANY today; flex routines are date-agnostic.
function practiceFixture(overrides: Record<string, unknown>): never {
  return {
    id: 'p', user_id: 'u', family_member_id: null, name: 'Routine',
    category: 'household', dtstart: '2026-01-01', recurrence_until: null,
    preferred_time_of_day: 'anytime', active: true,
    created_at: '2026-01-01', updated_at: '2026-01-01',
    recurrence_mode: 'pinned', recurrence_rule: { frequency: 'daily' },
    flex_period: null, flex_target: null,
    ...overrides,
  } as never
}

function daysAgoIso(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// Freeze "now" to a fixed Wednesday so the date-relative fixtures
// (midWeekIso → Wednesday, otherDayThisWeek, etc.) are deterministic on any
// day the suite runs — otherwise mid-week todos/reminders only land in the
// default "Today" view when the real day happens to be Wednesday, and a
// mid-week todo reads as overdue from Thursday on. Only Date is faked so
// setInterval (useNow) and userEvent keep real timers.
const FROZEN_NOW = new Date(2026, 5, 17, 12, 0, 0) // Wed 17 Jun 2026, local noon
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FROZEN_NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ScheduleOverview', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the schedule sections with the ranged week tabs', () => {
    renderOverview([])
    expect(screen.getByText('Your Schedule')).toBeInTheDocument()
    expect(screen.getByText('This month')).toBeInTheDocument()
    // The old "This week" heading is replaced by a Today/This Week/Next Week tablist.
    expect(screen.getByTestId('week-card')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'This Week' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Next Week' })).toBeInTheDocument()
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

  it('folds today-applicable routines into the week card and toggles them', async () => {
    const user = userEvent.setup()
    const { listPractices, completionsThisWeek, markPracticeDone, unmarkPracticeDone } =
      await import('../services/practiceService')
    // Pinned daily with a past dtstart → due on ANY today (no calendar flakiness).
    const sunscreen = practiceFixture({
      id: 'p1', name: 'Sunscreen', recurrence_mode: 'pinned',
      recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null,
      preferred_time_of_day: 'morning',
    })
    // Flex weekly, 0 completions → under target → applicable.
    const gym = practiceFixture({
      id: 'p2', name: 'Gym', recurrence_mode: 'flex_count', recurrence_rule: null,
      flex_period: 'week', flex_target: 3, preferred_time_of_day: 'anytime',
    })
    // Flex weekly already MET (target 1, 1 completion this week) → NOT applicable.
    const walk = practiceFixture({
      id: 'p3', name: 'Walk', recurrence_mode: 'flex_count', recurrence_rule: null,
      flex_period: 'week', flex_target: 1, preferred_time_of_day: 'anytime',
    })
    vi.mocked(listPractices).mockResolvedValue([sunscreen, gym, walk])
    vi.mocked(completionsThisWeek).mockResolvedValue([
      { practice_id: 'p3', completed_on: todayIso() } as never,
    ])
    renderOverview([])

    const week = screen.getByTestId('week-card')
    expect(await within(week).findByText(/Sunscreen \(daily\)/)).toBeInTheDocument()
    expect(within(week).getByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()
    // A flex routine already at target does not fold in.
    expect(within(week).queryByText(/Walk/)).not.toBeInTheDocument()

    // Ticking the routine marks it done…
    const sunscreenRow = within(week).getByText(/Sunscreen \(daily\)/).closest('li') as HTMLElement
    await user.click(within(sunscreenRow).getByRole('checkbox'))
    expect(vi.mocked(markPracticeDone)).toHaveBeenCalledWith('p1', todayIso())

    // …and unticking an already-done routine unmarks it.
    vi.mocked(completionsThisWeek).mockResolvedValue([
      { practice_id: 'p1', completed_on: todayIso() } as never,
    ])
    renderOverview([])
    const weekCards = screen.getAllByTestId('week-card')
    const week2 = weekCards[weekCards.length - 1]
    const doneRow = (await within(week2).findByText(/Sunscreen \(daily\)/)).closest('li') as HTMLElement
    await user.click(within(doneRow).getByRole('checkbox'))
    expect(vi.mocked(unmarkPracticeDone)).toHaveBeenCalledWith('p1', todayIso())
  })

  it('renders a today event inside the week card', () => {
    renderOverview([makeEvent({ id: 'e1', title: 'Weekly call', start_date: todayIso() })])
    const week = screen.getByTestId('week-card')
    expect(within(week).getByText('Weekly call')).toBeInTheDocument()
  })

  it('defaults to the Today range — only today\'s events show', () => {
    renderOverview([
      makeEvent({ id: 'tdy', title: 'School run', start_date: middayIso(new Date()) }),
      makeEvent({ id: 'oth', title: 'Other day meeting', start_date: middayIso(otherDayThisWeek()) }),
    ])
    const week = screen.getByTestId('week-card')
    expect(within(week).getByText('School run')).toBeInTheDocument()
    // The other in-week day is hidden under the default Today view.
    expect(within(week).queryByText('Other day meeting')).not.toBeInTheDocument()
  })

  it('tapping "This Week" reveals other in-week days', async () => {
    const user = userEvent.setup()
    renderOverview([
      makeEvent({ id: 'tdy', title: 'School run', start_date: middayIso(new Date()) }),
      makeEvent({ id: 'oth', title: 'Other day meeting', start_date: middayIso(otherDayThisWeek()) }),
    ])
    const week = screen.getByTestId('week-card')
    expect(within(week).queryByText('Other day meeting')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'This Week' }))
    expect(within(week).getByText('Other day meeting')).toBeInTheDocument()
    expect(within(week).getByText('School run')).toBeInTheDocument()
  })

  it('tapping "Next Week" shows next-week events but no routines', async () => {
    const user = userEvent.setup()
    const { listPractices, completionsThisWeek } = await import('../services/practiceService')
    vi.mocked(completionsThisWeek).mockResolvedValue([])
    // A pinned-daily routine that folds into Today — must NOT appear under Next Week.
    vi.mocked(listPractices).mockResolvedValue([
      practiceFixture({
        id: 'p1', name: 'Gym', recurrence_mode: 'flex_count', recurrence_rule: null,
        flex_period: 'week', flex_target: 3, preferred_time_of_day: 'anytime',
      }),
    ])
    renderOverview([
      makeEvent({ id: 'nw', title: 'Next-week trip', start_date: middayIso(nextWeekDay()) }),
    ])
    const week = screen.getByTestId('week-card')
    // Routine folds into the default Today view first.
    expect(await within(week).findByText(/Gym \(0\/3 this week\)/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Next Week' }))
    expect(within(week).getByText('Next-week trip')).toBeInTheDocument()
    // Routines are today-only; the Gym label must be gone under Next Week.
    expect(within(week).queryByText(/Gym \(0\/3 this week\)/)).not.toBeInTheDocument()
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

  it('renders a subject name chip when subjectNames contains the event subject_id', () => {
    render(
      <MemoryRouter>
        <ScheduleOverview
          events={[makeEvent({ id: 'sub1', title: 'Weekly call', start_date: todayIso(), subject_id: 'fm1' })]}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
          subjectNames={{ fm1: 'Milo' }}
        />
      </MemoryRouter>
    )
    expect(screen.getByText('Milo')).toBeInTheDocument()
  })

  it('renders a custom heading when provided (group Schedule view)', () => {
    render(
      <MemoryRouter>
        <ScheduleOverview
          events={[]}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
          heading="My Family"
        />
      </MemoryRouter>
    )
    expect(screen.getByText('My Family')).toBeInTheDocument()
    expect(screen.queryByText('Your Schedule')).not.toBeInTheDocument()
  })

  it('omits personal routines from the week card when hideRoutines is set', async () => {
    const { listPractices, completionsThisWeek } = await import('../services/practiceService')
    vi.mocked(completionsThisWeek).mockResolvedValue([])
    vi.mocked(listPractices).mockResolvedValue([
      practiceFixture({
        id: 'p1', name: 'Sunscreen', recurrence_mode: 'pinned',
        recurrence_rule: { frequency: 'daily' }, flex_period: null, flex_target: null,
        preferred_time_of_day: 'morning',
      }),
    ])
    render(
      <MemoryRouter>
        <ScheduleOverview
          events={[]}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
          hideRoutines
        />
      </MemoryRouter>
    )
    const week = screen.getByTestId('week-card')
    // Give the routines hook a chance to resolve, then confirm nothing folded in.
    await vi.waitFor(() => expect(vi.mocked(listPractices)).toHaveBeenCalled())
    expect(within(week).queryByText(/Sunscreen/)).not.toBeInTheDocument()
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

describe('ScheduleOverview — today schedule card', () => {
  function renderWithSchedule(props: {
    attendancesToday?: Parameters<typeof ScheduleOverview>[0]['attendancesToday']
    obligationsToday?: Parameters<typeof ScheduleOverview>[0]['obligationsToday']
  }) {
    return render(
      <MemoryRouter>
        <ScheduleOverview
          events={[]}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
          attendancesToday={props.attendancesToday}
          obligationsToday={props.obligationsToday}
        />
      </MemoryRouter>
    )
  }

  it('is absent when there are no attendances or obligations', () => {
    renderWithSchedule({})
    expect(screen.queryByTestId('today-schedule-card')).not.toBeInTheDocument()
  })

  it('renders indicative attendances muted and obligations as timed rows', () => {
    renderWithSchedule({
      attendancesToday: [{
        attendance_id: 'a1', family_member_id: 'm1', date: todayIso(),
        name: 'example school', location_id: null,
        start_time: '08:30', end_time: '15:30', priority: 0,
        dtstart: '2026-01-01', recurrence_until: null,
      }],
      obligationsToday: [{
        obligation_id: 'o1', role: 'drop', date: todayIso(), time: '08:15',
        location_id: null, source_attendance_id: 'a1', source_name: 'example school',
      }],
    })
    const card = screen.getByTestId('today-schedule-card')
    // Attendance is indicative (muted), labelled with its time range.
    const attendance = within(card).getByTestId('attendance-row')
    expect(attendance).toHaveTextContent('example school (08:30–15:30)')
    expect(attendance).toHaveTextContent('indicative')
    expect(attendance.className).toContain('text-gray-400')
    // Obligation is actionable, labelled "drop · …" with its anchor time.
    const obligation = within(card).getByTestId('obligation-row')
    expect(obligation).toHaveTextContent('drop · example school')
    expect(obligation).toHaveTextContent('08:15')
    // No conflict/overlap marker on indicative attendances.
    expect(within(card).queryByText(/overlaps/i)).not.toBeInTheDocument()
  })
})

describe('pinned trips (starred-group Schedule view)', () => {
  function renderPinned(events: Event[], onEdit = vi.fn()) {
    return render(
      <MemoryRouter>
        <ScheduleOverview
          events={events}
          onEdit={onEdit}
          onDelete={vi.fn()}
          onShareSuccess={vi.fn()}
          onHashtagClick={vi.fn()}
          preferredVisitDates={{}}
          pinTrips
        />
      </MemoryRouter>
    )
  }

  const trip = () => makeEvent({
    id: 'trip1', title: 'Canada Trip', event_kind: 'container',
    start_date: midWeekIso(), end_date: '2099-12-31',
  })

  it('pins a Trips section for trip containers, collapsed by default', () => {
    renderPinned([trip()])
    const card = screen.getByTestId('trips-section')
    expect(within(card).getByText('Trips')).toBeInTheDocument()
    // collapsed by default (like My Plans) — the trip title is hidden until expanded
    expect(within(card).queryByText('Canada Trip')).toBeNull()
  })

  it('renders no Trips section when pinTrips is off', () => {
    renderOverview([trip()])
    expect(screen.queryByTestId('trips-section')).toBeNull()
  })

  it('expanding then clicking a pinned trip opens it via onEdit', async () => {
    const onEdit = vi.fn()
    renderPinned([trip()], onEdit)
    const card = screen.getByTestId('trips-section')
    await userEvent.click(within(card).getByRole('button', { name: /trips/i }))
    await userEvent.click(within(card).getByLabelText('Edit trip Canada Trip'))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'trip1' }))
  })
})
