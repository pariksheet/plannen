import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const getAuthorizationDetails = vi.fn()
const approveAuthorization = vi.fn()
const denyAuthorization = vi.fn()

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      oauth: {
        getAuthorizationDetails: (...a: unknown[]) => getAuthorizationDetails(...a),
        approveAuthorization: (...a: unknown[]) => approveAuthorization(...a),
        denyAuthorization: (...a: unknown[]) => denyAuthorization(...a),
      },
    },
  },
}))

const mockAuth = { user: { id: 'u1', email: 'p@x.com' } as { id: string; email: string } | null, loading: false }
vi.mock('../../src/context/AuthContext', () => ({
  useAuth: () => mockAuth,
}))

import { OAuthConsent } from '../../src/pages/OAuthConsent'

function renderConsent(search = '?authorization_id=auth-123') {
  return render(
    <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.user = { id: 'u1', email: 'p@x.com' }
  mockAuth.loading = false
})

describe('OAuthConsent', () => {
  it('shows client name and scopes when consent is needed', async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: 'auth-123',
        client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
        user: { id: 'u1', email: 'p@x.com' },
        scope: 'openid email',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      },
      error: null,
    })
    renderConsent()
    await waitFor(() => expect(screen.getAllByText(/Claude/).length).toBeGreaterThan(0))
    expect(getAuthorizationDetails).toHaveBeenCalledWith('auth-123')
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument()
  })

  it('approve calls approveAuthorization with the authorization id', async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: 'auth-123',
        client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
        user: { id: 'u1', email: 'p@x.com' },
        scope: 'openid email',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      },
      error: null,
    })
    approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?code=x' }, error: null })
    renderConsent()
    await waitFor(() => screen.getByRole('button', { name: /approve/i }))
    await userEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(approveAuthorization).toHaveBeenCalledWith('auth-123')
  })

  it('deny calls denyAuthorization with the authorization id', async () => {
    getAuthorizationDetails.mockResolvedValue({
      data: {
        authorization_id: 'auth-123',
        client: { id: 'c1', name: 'Claude', uri: '', logo_uri: '' },
        user: { id: 'u1', email: 'p@x.com' },
        scope: 'openid email',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      },
      error: null,
    })
    denyAuthorization.mockResolvedValue({ data: { redirect_url: 'https://claude.ai/cb?error=access_denied' }, error: null })
    renderConsent()
    await waitFor(() => screen.getByRole('button', { name: /deny/i }))
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(denyAuthorization).toHaveBeenCalledWith('auth-123')
  })

  it('redirects to login (preserving the consent URL) when logged out', async () => {
    mockAuth.user = null
    renderConsent()
    await waitFor(() => expect(screen.getByText('login-page')).toBeInTheDocument())
  })

  it('shows an error when authorization_id is missing', async () => {
    renderConsent('')
    await waitFor(() => expect(screen.getByText(/missing authorization/i)).toBeInTheDocument())
    expect(getAuthorizationDetails).not.toHaveBeenCalled()
  })
})
