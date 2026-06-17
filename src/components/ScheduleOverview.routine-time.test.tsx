import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../hooks/useTodayRoutines', () => ({
  useTodayRoutines: () => ({
    routines: [{ id: 'r1', label: 'Brush Milo Before Sleep (daily)', done: false, sortMins: 1200, timeLabel: '20:00' }],
    toggle: vi.fn(),
  }),
}))
vi.mock('../services/weatherService', () => ({ getTodayWeather: () => Promise.resolve(null) }))
vi.mock('../services/profileService', () => ({ getLocations: () => Promise.resolve({ data: [] }) }))

import { ScheduleOverview } from './ScheduleOverview'

const noop = () => {}
const actions = { onEdit: noop, onDelete: noop, onShareSuccess: noop, onHashtagClick: noop } as any

describe('ScheduleOverview routine time', () => {
  it('renders a timed routine with its HH:MM label', async () => {
    render(<ScheduleOverview events={[]} {...actions} />)
    expect(await screen.findByText('20:00')).toBeInTheDocument()
    expect(screen.getByText(/Brush Milo Before Sleep/)).toBeInTheDocument()
  })
})
