import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EventForm } from './EventForm'

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

    // Fill start date (lean flow shows start date on step 1)
    const startInput = screen.getByLabelText(/start date/i)
    await user.type(startInput, '2026-12-01T10:00')

    // The lean "Create" fast-path button should be available on step 1
    const createBtn = screen.getByRole('button', { name: /^create$/i })
    await user.click(createBtn)

    await waitFor(() => {
      expect(mockCreateEvent).toHaveBeenCalled()
    })

    const [submittedData] = mockCreateEvent.mock.calls[0] as [Record<string, unknown>, ...unknown[]]
    expect(submittedData.event_kind).toBe('todo')
  })
})
