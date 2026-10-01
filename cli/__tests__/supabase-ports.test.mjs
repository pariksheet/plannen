import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { portsFor, readSupabasePorts, SUPABASE_DEFAULT_PORTS } from '../lib/profiles.mjs';

describe('readSupabasePorts', () => {
  it('reads api/db/studio ports from a supabase/config.toml', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'plannen-sbports-'));
    const toml = path.join(dir, 'config.toml');
    writeFileSync(toml, [
      'project_id = "x"',
      '[api]', 'enabled = true', 'port = 55321',
      '[db]', 'port = 55322', 'shadow_port = 55320',
      '[studio]', 'port = 55323',
      '[inbucket]', 'port = 55324',
    ].join('\n'));
    expect(readSupabasePorts(toml)).toEqual({ api: 55321, db: 55322, studio: 55323 });
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the stock Supabase ports when the file is missing', () => {
    expect(readSupabasePorts('/nonexistent/config.toml')).toEqual(SUPABASE_DEFAULT_PORTS);
    expect(SUPABASE_DEFAULT_PORTS).toEqual({ api: 54321, db: 54322, studio: 54323 });
  });
});

describe('portsFor(local_sb)', () => {
  // `supabase start` only honours supabase/config.toml, so a profile's port
  // offset cannot move the Supabase stack. Advertising offset ports made
  // `plannen status` report the stack down while it was up on the stock ports.
  it('does not offset the Supabase ports — they are fixed by config.toml', () => {
    const p = portsFor('local_sb', 200, { supabasePorts: { api: 54321, db: 54322, studio: 54323 } });
    expect(p.PLANNEN_SUPABASE_API_PORT).toBe('54321');
    expect(p.PLANNEN_PG_PORT).toBe('54322');
    expect(p.PLANNEN_SUPABASE_STUDIO_PORT).toBe('54323');
  });

  it('still offsets the web dev port, which the profile does control', () => {
    const p = portsFor('local_sb', 200, { supabasePorts: { api: 54321, db: 54322, studio: 54323 } });
    expect(p.PLANNEN_WEB_PORT).toBe('4521');
  });

  it('reports the studio port from config.toml (54323), not the mailpit port', () => {
    const p = portsFor('local_sb', 0);
    expect(p.PLANNEN_SUPABASE_STUDIO_PORT).toBe('54323');
  });

  it('local_pg ports are unchanged by this rule', () => {
    expect(portsFor('local_pg', 100)).toEqual({
      PLANNEN_PG_PORT: '54422',
      PLANNEN_BACKEND_PORT: '54423',
      PLANNEN_WEB_PORT: '4421',
    });
  });
});
