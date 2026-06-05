import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MuteSyncDialog } from '../../src/components/MuteSyncDialog'
import type { EventProvenanceRow } from '../../src/lib/dbClient/types'

const provenance: EventProvenanceRow = {
  event_id: 'evt-1',
  source: 'mailbox',
  adapter_id: 'gmail',
  source_message_id: 't1',
  sender_display: 'Acme Life <n@e.acmelife.com>',
  sender_email: 'n@e.acmelife.com',
  sender_domain: 'e.acmelife.com',
  subject: 'Policy Renewal Reminder',
  created_at: '2026-05-27T10:00:00Z',
}

describe('MuteSyncDialog', () => {
  it('defaults the radio to domain and pre-fills subject keyword', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={provenance} />)
    expect((screen.getByLabelText(/whole domain/i) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByDisplayValue('Renewal')).toBeInTheDocument()
  })

  it('also-delete is checked by default', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={provenance} />)
    expect((screen.getByLabelText(/also delete/i) as HTMLInputElement).checked).toBe(true)
  })

  it('clicking Mute on sender kind fires onConfirm with the right spec', () => {
    const onConfirm = vi.fn()
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={onConfirm} eventId="evt-1" provenance={provenance} />)
    fireEvent.click(screen.getByRole('radio', { name: /this sender/i }))
    fireEvent.click(screen.getByRole('button', { name: /^mute$/i }))
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'sender',
      pattern: 'n@e.acmelife.com',
      subject_keyword: null,
      alsoDeleteCurrent: true,
    })
  })

  it('domain_subject submission carries the subject_keyword', () => {
    const onConfirm = vi.fn()
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={onConfirm} eventId="evt-1" provenance={provenance} />)
    fireEvent.click(screen.getByRole('radio', { name: /domain \+ subject keyword/i }))
    fireEvent.click(screen.getByRole('button', { name: /^mute$/i }))
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'domain_subject',
      pattern: 'e.acmelife.com',
      subject_keyword: 'Renewal',
      alsoDeleteCurrent: true,
    })
  })

  it('falls back to sender-only manual input when provenance is null', () => {
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={vi.fn()} eventId="evt-1" provenance={null} />)
    expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/whole domain/i)).toBeNull()
  })

  it('manual sender input populates the submitted pattern', () => {
    const onConfirm = vi.fn()
    render(<MuteSyncDialog isOpen onClose={() => {}} onConfirm={onConfirm} eventId="evt-1" provenance={null} />)
    fireEvent.change(screen.getByPlaceholderText(/email address/i), { target: { value: 'foo@bar.com' } })
    fireEvent.click(screen.getByRole('button', { name: /^mute$/i }))
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sender', pattern: 'foo@bar.com' }))
  })
})
