import { describe, it, expect, vi } from 'vitest';
import {
  latestAppliedVersion,
  readSeedWatermark,
  versionsNewerThan,
  watermarkHeader,
  withinBound,
} from '../../scripts/lib/seed-watermark.mjs';

describe('watermark header round-trip', () => {
  it('reads back what watermarkHeader writes', () => {
    const dump = `-- Local DB export\n${watermarkHeader('20260527140000_user_tokens')}\n\nINSERT INTO x VALUES (1);\n`;
    expect(readSeedWatermark(dump)).toBe('20260527140000_user_tokens');
  });

  it('returns null for pre-watermark dumps', () => {
    expect(readSeedWatermark('-- Local DB export (Tier 1) 2026-05-12\nINSERT INTO x VALUES (1);\n')).toBeNull();
  });
});

describe('withinBound', () => {
  it('no bound → everything applies', () => {
    expect(withinBound('20260601000000_x', null)).toBe(true);
  });
  it('bounds lexicographically, inclusive', () => {
    expect(withinBound('20260527140000_user_tokens', '20260527140000_user_tokens')).toBe(true);
    expect(withinBound('20260528000000_later', '20260527140000_user_tokens')).toBe(false);
  });
  it('tier0 overlay versions always sort inside any real bound', () => {
    expect(withinBound('00000000000000_tier0_compat', '20260101000000_first')).toBe(true);
  });
});

describe('versionsNewerThan', () => {
  it('filters newer-than-watermark, ignoring the overlay', () => {
    const applied = ['00000000000000_tier0_compat', '20260519120000_a', '20260527140000_b', '20260601000000_c'];
    expect(versionsNewerThan(applied, '20260527140000_b')).toEqual(['20260601000000_c']);
    expect(versionsNewerThan(applied, '20260601000000_c')).toEqual([]);
  });
});

describe('latestAppliedVersion', () => {
  it('prefers the plannen tracking table', async () => {
    const client = { query: vi.fn(async () => ({ rows: [{ version: '20260527140000_b' }] })) };
    expect(await latestAppliedVersion(client)).toBe('20260527140000_b');
    expect(client.query).toHaveBeenCalledTimes(1);
  });
  it('falls back to the supabase CLI table, then null', async () => {
    const client = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error('relation does not exist'))
        .mockResolvedValueOnce({ rows: [{ version: '20260520000000_cloud' }] }),
    };
    expect(await latestAppliedVersion(client)).toBe('20260520000000_cloud');
    const empty = { query: vi.fn().mockRejectedValue(new Error('nope')) };
    expect(await latestAppliedVersion(empty)).toBeNull();
  });
});
