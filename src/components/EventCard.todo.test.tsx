import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventCard } from './EventCard'
import { Event } from '../types/event'

// --- Mocks required by EventCard's import chain ---

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(() => ({ user: null })),
}))

vi.mock('../services/rsvpService', () => ({
  getMyRsvp: vi.fn(async () => ({ data: null, error: null })),
  getRsvpList: vi.fn(async () => ({ data: null, error: null })),
}))

vi.mock('../services/eventService', () => ({
  getEvent: vi.fn(async () => ({ data: null, error: null })),
}))
vi.mock('../services/shareService', () => ({
  isShared: (e: { shared_summary?: { groups: number; users: number; all: boolean } | null; shared_with_friends?: string }) => {
    const s = e.shared_summary
    if (s) return s.groups > 0 || s.users > 0 || s.all
    return (e.shared_with_friends ?? 'none') !== 'none'
  },
}))

vi.mock('../services/agentTaskService', () => ({
  getEventWatchTask: vi.fn(async () => null),
}))

vi.mock('./RSVPButton', () => ({
  RSVPButton: () => <div data-testid="rsvp-button" />,
}))

vi.mock('./RSVPList', () => ({
  RSVPList: () => <div data-testid="rsvp-list" />,
}))

vi.mock('./EventMemory', () => ({
  EventMemoryComponent: () => <div data-testid="event-memory" />,
}))

vi.mock('./WatchForNextYearButton', () => ({
  WatchForNextYearButton: () => <div data-testid="watch-button" />,
}))

vi.mock('./PreferredVisitDate', () => ({
  PreferredVisitDate: () => <div data-testid="preferred-visit" />,
}))

vi.mock('./EventShareModal', () => ({
  EventShareModal: () => <div data-testid="share-modal" />,
}))

vi.mock('./EventInviteModal', () => ({
  EventInviteModal: () => <div data-testid="invite-modal" />,
}))

vi.mock('./EventDetailsModal', () => ({
  EventDetailsModal: () => <div data-testid="details-modal" />,
}))

vi.mock('../services/calendarExport', () => ({
  downloadIcs: vi.fn(),
  getGoogleCalendarAddUrl: vi.fn(() => '#'),
  getOutlookCalendarAddUrl: vi.fn(() => '#'),
}))

vi.mock('../utils/whatsappShare', () => ({
  getWhatsAppShareUrl: vi.fn(() => '#'),
}))

vi.mock('../lib/tier', () => ({
  isTierZero: vi.fn(() => false),
}))

// --- Test data ---

const todo: Event = {
  id: 't1', title: 'Renew passport', description: null,
  start_date: '2020-01-01T09:00:00.000Z', end_date: null,
  enrollment_url: null, enrollment_deadline: null, enrollment_start_date: null,
  image_url: null, location: null, hashtags: null,
  event_kind: 'todo', event_type: 'personal', event_status: 'going',
  created_by: 'u1', created_at: '', updated_at: '', shared_with_friends: 'none',
  completed_at: null, assigned_to: 'u1',
}

describe('EventCard todo', () => {
  it('renders a checkbox for a todo', () => {
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect(screen.getByRole('checkbox')).toBeInTheDocument()
  })
  it('shows an overdue tag for a past, open todo', () => {
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect(screen.getByText(/overdue/i)).toBeInTheDocument()
  })
  it('checked + strikethrough when completed', () => {
    render(<EventCard event={{ ...todo, completed_at: '2026-06-08T00:00:00Z' }} viewMode="compact" onToggleTodo={vi.fn()} />)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    expect(screen.getAllByText('Renew passport')[0].className).toMatch(/line-through/)
    expect(screen.queryByText(/overdue/i)).toBeNull()
  })
  it('calls onToggleTodo when the checkbox is clicked', () => {
    const onToggleTodo = vi.fn()
    render(<EventCard event={todo} viewMode="compact" onToggleTodo={onToggleTodo} />)
    screen.getByRole('checkbox').click()
    expect(onToggleTodo).toHaveBeenCalledWith(todo)
  })
  it('does not render RSVP controls for a todo', () => {
    render(<EventCard event={todo} viewMode="compact" showRSVP onToggleTodo={vi.fn()} />)
    expect(screen.queryByText(/going/i)).toBeNull()
  })
  it('offers convert in detailed view', () => {
    const onConvertKind = vi.fn()
    render(<EventCard event={todo} viewMode="detailed" onToggleTodo={vi.fn()} onConvertKind={onConvertKind} />)
    const trigger = screen.getByLabelText('Add to calendar')
    fireEvent.click(trigger)
    const convertBtn = screen.getByText('Convert to reminder')
    fireEvent.click(convertBtn)
    expect(onConvertKind).toHaveBeenCalledWith(todo, 'reminder')
  })
  it('does not render a kebab in detailed view when no onConvertKind is given for a lean card', () => {
    render(<EventCard event={todo} viewMode="detailed" onToggleTodo={vi.fn()} />)
    expect(screen.queryByLabelText('Add to calendar')).toBeNull()
  })
})
