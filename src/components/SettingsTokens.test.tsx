import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SettingsTokens } from './SettingsTokens';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input, init) => handler(input, init)));
}

describe('SettingsTokens', () => {
  it('lists tokens fetched from /functions/v1/mcp-token', async () => {
    mockFetch(async (_url, init) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return new Response(JSON.stringify([
          { id: 't1', label: 'MacBook', prefix: 'plnnn_abc', created_at: '2026-05-01', last_used_at: null, expires_at: null },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    });
    render(<SettingsTokens jwt="test-jwt" supabaseUrl="https://x" />);
    await waitFor(() => expect(screen.getByText('MacBook')).toBeInTheDocument());
    expect(screen.getByText(/plnnn_abc/)).toBeInTheDocument();
  });

  it('mints a token on Generate click and shows the plaintext once', async () => {
    const calls: any[] = [];
    mockFetch(async (_url, init) => {
      calls.push({ method: init?.method ?? 'GET', body: init?.body });
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({
          id: 't-new', plaintext: 'plnnn_NEW' + 'a'.repeat(40), prefix: 'plnnn_NEW',
          label: 'Laptop', created_at: '2026-05-19', expires_at: null,
        }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    render(<SettingsTokens jwt="test-jwt" supabaseUrl="https://x" />);
    fireEvent.click(screen.getByText(/generate/i));
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByText(/create/i));
    await waitFor(() => expect(screen.getByText(/plnnn_NEW/)).toBeInTheDocument());
    expect(screen.getByText(/save this token/i)).toBeInTheDocument();
  });
});
