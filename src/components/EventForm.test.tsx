import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventForm, nextRoundedHourLocal, plusOneHourLocal } from './EventForm'

// --- service mocks -----------------------------------------------------------

const mockCreateEvent = vi.fn()

vi.mock('../services/eventService', () => ({
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  updateEvent: vi.fn(async () => ({ data: null, error: null })),
  getEventSharedWithUserIds: vi.fn(async () => ({ data: [], error: null })),
  getEventSharedWithGroupIds: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/agentTaskService', () => ({
  createRecurringTask: vi.fn(async () => {}),
}))
vi.mock('../services/relationshipService', () => ({
  getMyConnections: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/groupService', () => ({
  getMyGroups: vi.fn(async () => ({ data: [], error: null })),
}))
vi.mock('../services/rsvpService', () => ({
  getMyRsvp: vi.fn(async () => ({ data: null, error: null })),
  setPreferredVisitDate: vi.fn(async () => ({ error: null })),
}))
vi.mock('../services/eventCoverService', () => ({
  uploadEventCover: vi.fn(async () => ({ data: null, error: null })),
}))
const mockAssignToContainer = vi.fn(async () => ({ error: null }))
vi.mock('../services/containerService', () => ({
  listContainers: vi.fn(async () => ({ data: [{ id: 't1', title: 'Italy', start_date: '2026-07-01T00:00:00Z', end_date: null }], error: null })),
  createContainer: vi.fn(async () => ({ data: null, error: null })),
  assignToContainer: (...args: unknown[]) => mockAssignToContainer(...args),
}))
vi.mock('../hooks/useAgent', () => ({
  useAgent: () => ({
    scrapeUrl: vi.fn(async () => ({ data: null, error: null })),
    extractFromImage: vi.fn(async () => ({ data: null, error: null })),
  }),
}))
vi.mock('../lib/tier', () => ({
  isTierZero: () => false,
}))

// jsdom doesn't implement scrollTo — stub it so the useEffect in EventForm
// doesn't throw when the step changes.
beforeEach(() => {
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
})

// --- helpers -----------------------------------------------------------------

function renderForm() {
  const onClose = vi.fn()
  const onSuccess = vi.fn()
  render(<EventForm onClose={onClose} onSuccess={onSuccess} />)
  return { onClose, onSuccess }
}

// --- tests -------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EventForm – To-do kind', () => {
  it('renders a To-do kind button', () => {
    renderForm()
    expect(screen.getByRole('button', { name: /^to-do$/i })).toBeInTheDocument()
  })

  it('creates a todo when To-do kind is selected', async () => {
    const user = userEvent.setup()

    mockCreateEvent.mockResolvedValue({ data: { id: 'new-1' }, error: null })

    renderForm()

    // Select To-do kind
    await user.click(screen.getByRole('button', { name: /^to-do$/i }))

    // Fill title
    const titleInput = screen.getByLabelText(/title/i)
    await user.type(titleInput, 'Renew passport')

    // Fill the due date (to-dos are a single step with a "Due date" field,
    // pre-seeded with a default, so clear it before typing the test value).
    const startInput = screen.getByLabelText(/due date/i)
    await user.clear(startInput)
    await user.type(startInput, '2026-12-01T10:00')

    // To-dos are single-step, so the footer button is "Create".
    const createBtn = screen.getByRole('button', { name: /^create$/i })
    await user.click(createBtn)

    await waitFor(() => {
      expect(mockCreateEvent).toHaveBeenCalled()
    })

    const [submittedData] = mockCreateEvent.mock.calls[0] as [Record<string, unknown>, ...unknown[]]
    expect(submittedData.event_kind).toBe('todo')
  })

  it('creates a Trip (container) via the Trip kind', async () => {
    const user = userEvent.setup()
    mockCreateEvent.mockResolvedValue({ data: { id: 'trip-1', event_kind: 'container' }, error: null })
    renderForm()
    await user.click(screen.getByRole('button', { name: /^trip$/i }))
    await user.type(screen.getByLabelText(/title/i), 'Canada')
    // Trip is a 3-step flow (Basics → When → Sharing); dates are pre-seeded.
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalled())
    const [data] = mockCreateEvent.mock.calls[0] as [Record<string, unknown>, ...unknown[]]
    expect(data.event_kind).toBe('container')
    // A trip carries no enrollment URL.
    expect(data.enrollment_url).toBe('')
  })

  it('assigns the event to a chosen trip after create', async () => {
    const user = userEvent.setup()
    mockCreateEvent.mockResolvedValue({ data: { id: 'new-9', event_kind: 'todo' }, error: null })
    renderForm()
    await user.click(screen.getByRole('button', { name: /^to-do$/i }))
    await user.type(screen.getByLabelText(/title/i), 'Pack bags')
    // Opt into a trip via the checkbox, then the picker appears once trips load.
    await user.click(screen.getByRole('checkbox', { name: /add to a trip/i }))
    const select = await screen.findByLabelText(/choose trip/i)
    await user.selectOptions(select, 't1')
    await user.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(mockAssignToContainer).toHaveBeenCalledWith('new-9', 't1'))
  })
})

describe('date helpers', () => {
  it('nextRoundedHourLocal returns the next top-of-hour with zero minutes', () => {
    const v = nextRoundedHourLocal(new Date(2026, 0, 5, 14, 23))
    expect(v).toBe('2026-01-05T15:00')
  })

  it('nextRoundedHourLocal advances to the next hour even when already on the hour', () => {
    const v = nextRoundedHourLocal(new Date(2026, 0, 5, 14, 0))
    expect(v).toBe('2026-01-05T15:00')
  })

  it('plusOneHourLocal adds an hour to a datetime-local string', () => {
    expect(plusOneHourLocal('2026-01-05T15:00')).toBe('2026-01-05T16:00')
    expect(plusOneHourLocal('')).toBe('')
  })
})

describe('EventForm – smart defaults & validation', () => {
  it('pre-seeds a default start (top-of-hour) and end on create (event)', async () => {
    const user = userEvent.setup()
    renderForm()
    // Event is the default kind; its date fields live on step 2.
    await user.type(screen.getByLabelText(/title/i), 'Picnic')
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement
    expect(startInput.value).not.toBe('')
    expect(startInput.value.endsWith(':00')).toBe(true)
    // Events default the end to one hour after the start.
    expect(endInput.value).toBe(plusOneHourLocal(startInput.value))
  })

  it('does not give a to-do an end field', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole('button', { name: /^to-do$/i }))
    expect(screen.getByLabelText(/due date/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/end (date|time)/i)).toBeNull()
  })

  it('shows a soft note when a pasted link cannot be read', async () => {
    const user = userEvent.setup()
    renderForm()
    // Default kind is "event", so the URL field is on step 1.
    const urlInput = screen.getByLabelText(/event link/i)
    await user.type(urlInput, 'https://example.org/x')
    expect(await screen.findByText(/couldn't read that link/i)).toBeInTheDocument()
  })

  it('passes a recurrence_rule when a repeat is chosen on create', async () => {
    const user = userEvent.setup()
    mockCreateEvent.mockResolvedValue({ data: { id: 'r1', event_kind: 'event' }, error: null })
    renderForm()
    // Event kind is the default. Step 1: title.
    await user.type(screen.getByLabelText(/title/i), 'Swim class')
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    // Step 2: choose weekly recurrence (start date is pre-seeded).
    await user.selectOptions(screen.getByLabelText(/repeats/i), 'weekly')
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    // Step 3 (sharing) → Step 4 (options)
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    await user.click(screen.getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalled())
    const [submitted] = mockCreateEvent.mock.calls[0] as [Record<string, unknown>, ...unknown[]]
    const rule = submitted.recurrence_rule as { frequency: string; count: number; days?: string[] }
    expect(rule.frequency).toBe('weekly')
    expect(rule.count).toBe(8)
    expect(rule.days?.length).toBe(1)
  })

  it('offers a one-day checkbox only for multi-day events; picker defaults to the start day', async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText(/title/i), 'Festival')
    await user.click(screen.getByRole('button', { name: /^next$/i }))
    // Default start/end are the same day → no one-day option at all.
    expect(screen.queryByRole('checkbox', { name: /only going on one day/i })).toBeNull()

    const startInput = screen.getByLabelText(/start date/i)
    await user.clear(startInput)
    await user.type(startInput, '2026-07-01T10:00')
    const endInput = screen.getByLabelText(/end date/i)
    await user.clear(endInput)
    await user.type(endInput, '2026-07-05T18:00')

    // Multi-day now → the checkbox appears, but the picker is hidden until ticked.
    const checkbox = await screen.findByRole('checkbox', { name: /only going on one day/i })
    expect(screen.queryByLabelText(/visit day/i)).toBeNull()
    await user.click(checkbox)
    const visit = (await screen.findByLabelText(/visit day/i)) as HTMLInputElement
    expect(visit.value).toBe('2026-07-01T10:00')
  })

  it('blocks submit when the end is not after the start', async () => {
    const user = userEvent.setup()
    mockCreateEvent.mockResolvedValue({ data: { id: 'x' }, error: null })
    renderForm()
    // Reminder is single-step and has an optional end field.
    await user.click(screen.getByRole('button', { name: /^reminder$/i }))
    await user.type(screen.getByLabelText(/title/i), 'Bad range')

    const startInput = screen.getByLabelText(/date & time/i)
    await user.clear(startInput)
    await user.type(startInput, '2026-12-01T10:00')
    const endInput = screen.getByLabelText(/end time/i)
    await user.clear(endInput)
    await user.type(endInput, '2026-12-01T09:00')

    await user.click(screen.getByRole('button', { name: /^create$/i }))

    expect(await screen.findByText(/end time must be after the start time/i)).toBeInTheDocument()
    expect(mockCreateEvent).not.toHaveBeenCalled()
  })
})
