import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeProfileCreate } from './create.mjs';

let home;

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'plannen-cli-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('profile create --storage', () => {
  it('defaults to local-fs for local_pg', async () => {
    const { envPath } = await invokeProfileCreate({ name: 't', mode: 'local_pg' }, { env: { HOME: home } });
    expect(readFileSync(envPath, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=local-fs');
  });

  it('defaults to supabase for local_sb / cloud_sb', async () => {
    const { envPath: a } = await invokeProfileCreate({ name: 's1', mode: 'local_sb' }, { env: { HOME: home } });
    expect(readFileSync(a, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=supabase');
    const { envPath: b } = await invokeProfileCreate({ name: 'c1', mode: 'cloud_sb' }, { env: { HOME: home } });
    expect(readFileSync(b, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=supabase');
  });

  it('honours --storage s3 on cloud_sb', async () => {
    const { envPath } = await invokeProfileCreate(
      { name: 'r2', mode: 'cloud_sb', storage: 's3' },
      { env: { HOME: home } },
    );
    expect(readFileSync(envPath, 'utf8')).toContain('PLANNEN_STORAGE_BACKEND=s3');
  });

  it('refuses --storage s3 on local_pg', async () => {
    await expect(
      invokeProfileCreate({ name: 'bad', mode: 'local_pg', storage: 's3' }, { env: { HOME: home } }),
    ).rejects.toThrow(/not allowed with --mode=local_pg/);
  });
});
