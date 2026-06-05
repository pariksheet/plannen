import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// The handler lives outside cli/ but vitest config only matches cli/**.
// Importing across the boundary keeps test colocation simple for now.
import handler from '../../api/health.js';

const ORIG = { ...process.env };

beforeEach(() => {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.VERCEL_GIT_COMMIT_REF;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  process.env = { ...ORIG };
});

describe('/api/health', () => {
  it('returns 200 with status=ok JSON', async () => {
    const res = handler();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes Vercel build metadata when present', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc1234';
    process.env.VERCEL_GIT_COMMIT_REF = 'main';
    process.env.VERCEL_ENV = 'production';
    const body = await handler().json();
    expect(body.commit).toBe('abc1234');
    expect(body.branch).toBe('main');
    expect(body.env).toBe('production');
  });

  it('emits null commit/branch + env=unknown when Vercel vars are unset', async () => {
    const body = await handler().json();
    expect(body.commit).toBe(null);
    expect(body.branch).toBe(null);
    expect(body.env).toBe('unknown');
  });

  it('content-type is JSON', () => {
    const res = handler();
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
