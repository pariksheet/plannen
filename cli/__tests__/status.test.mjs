import { describe, it, expect, vi } from 'vitest';
import { invokeStatus } from '../commands/status.mjs';

describe('status', () => {
  it('reports tier 0 processes (pg/backend/web) with up/down per port', async () => {
    // Mock probe: pg up, backend down, web up. Receives the full proc object.
    const probe = vi.fn(async (proc) => {
      if (proc.port === 54322) return true;
      if (proc.port === 54323) return false;
      if (proc.port === 4321) return true;
      return false;
    });

    const lines = [];
    const out = { write: (s) => lines.push(s) };

    const code = await invokeStatus(
      { json: false },
      { env: { PLANNEN_TIER: '0' }, probe, out },
    );

    const joined = lines.join('');
    expect(joined).toMatch(/pg.*up/i);
    expect(joined).toMatch(/backend.*down/i);
    expect(joined).toMatch(/web.*up/i);
    expect(code).toBe(0);
  });

  it('reports tier 1 processes (supabase/web) — no backend', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: false }, { env: { PLANNEN_TIER: '1' }, probe, out });
    const joined = lines.join('');
    expect(joined).toMatch(/supabase/i);
    expect(joined).not.toMatch(/backend/i);
  });

  it('--json emits valid JSON with a `processes` array', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: true }, { env: { PLANNEN_TIER: '0' }, probe, out });
    const obj = JSON.parse(lines.join(''));
    expect(Array.isArray(obj.processes)).toBe(true);
    expect(obj.processes.every((p) => 'name' in p && 'port' in p && 'up' in p)).toBe(true);
  });

  it('--json includes tier + mode + per-process url', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: true }, { env: { PLANNEN_TIER: '0' }, probe, out });
    const obj = JSON.parse(lines.join(''));
    expect(obj.tier).toBe('0');
    expect(obj.mode).toBe('local_pg');
    const web = obj.processes.find((p) => p.name === 'web');
    expect(web.url).toBe('http://localhost:4321');
    const pg = obj.processes.find((p) => p.name === 'pg');
    expect(pg.url).toBe('postgresql://localhost:54322');
  });

  it('tier 2 includes an mcp entry pointing at <SUPABASE_URL>/functions/v1/mcp', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus(
      { json: true },
      {
        env: {
          PLANNEN_TIER: '2',
          SUPABASE_URL: 'https://abc.supabase.co',
          MCP_BEARER_TOKEN: 'tok-xyz',
        },
        probe,
        out,
      },
    );
    const obj = JSON.parse(lines.join(''));
    const mcp = obj.processes.find((p) => p.name === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp.url).toBe('https://abc.supabase.co/functions/v1/mcp');
    expect(mcp.scheme).toBe('https');
    expect(mcp.headers.Authorization).toBe('Bearer tok-xyz');
    // 405 (HEAD not allowed) should still count as up — okBelow:500.
    expect(mcp.okBelow).toBe(500);
  });

  it('tier 2 reads supabase/web URLs from .env (no pg, since it is part of the managed Supabase surface)', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus(
      { json: true },
      {
        env: {
          PLANNEN_TIER: '2',
          SUPABASE_URL: 'https://abc.supabase.co',
          DATABASE_URL: 'postgresql://u:secretpw@db.example.com:5432/postgres',
          PLANNEN_WEB_URL: 'https://app.example.com',
        },
        probe,
        out,
      },
    );
    const obj = JSON.parse(lines.join(''));
    const find = (n) => obj.processes.find((p) => p.name === n);
    expect(find('supabase').url).toBe('https://abc.supabase.co');
    expect(find('pg')).toBeUndefined();
    expect(find('web(local)').url).toBe('http://localhost:4321');
    expect(find('web(vercel)').url).toBe('https://app.example.com');
  });

  it('tier 2 marks web(vercel) as not configured when no URL env var is set', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: true }, { env: { PLANNEN_TIER: '2' }, probe, out });
    const obj = JSON.parse(lines.join(''));
    const vercel = obj.processes.find((p) => p.name === 'web(vercel)');
    expect(vercel.configured).toBe(false);
    expect(vercel.up).toBe(false);
  });

  it('text output includes a profile + tier+mode header and prints full URLs per process', async () => {
    const probe = vi.fn(async () => true);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: false }, { env: { PLANNEN_TIER: '1' }, probe, out });
    const joined = lines.join('');
    expect(joined).toMatch(/^profile: /);
    expect(joined).toMatch(/tier: 1 \(local_sb\)/);
    expect(joined).toMatch(/http:\/\/localhost:4321/);
    expect(joined).toMatch(/postgresql:\/\/localhost:54322/);
  });

  it('exits 0 even when nothing is running', async () => {
    const probe = vi.fn(async () => false);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    const code = await invokeStatus({ json: false }, { env: { PLANNEN_TIER: '0' }, probe, out });
    expect(code).toBe(0);
  });

  it('defaults tier to 0 when PLANNEN_TIER is unset', async () => {
    const probe = vi.fn(async () => false);
    const lines = [];
    const out = { write: (s) => lines.push(s) };
    await invokeStatus({ json: true }, { env: {}, probe, out });
    const obj = JSON.parse(lines.join(''));
    // Tier 0 has pg + backend + web; tier 1 doesn't have "backend".
    expect(obj.processes.some((p) => p.name === 'backend')).toBe(true);
  });
});
