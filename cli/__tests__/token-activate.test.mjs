import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'plannen-token-act-'));
  mkdirSync(path.join(tmpHome, '.plannen', 'profiles', 'default'), { recursive: true });
  writeFileSync(
    path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'),
    'PLANNEN_TIER=2\nPLANNEN_USER_EMAIL=me@x\n',
  );
  writeFileSync(path.join(tmpHome, '.plannen', 'active'), 'default\n');
});
afterEach(() => rmSync(tmpHome, { recursive: true, force: true }));

describe('plannen token activate', () => {
  it('writes PAT to profile env and calls rewritePluginJson', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    const rewrite = vi.fn();
    const pat = 'plnnn_' + 'a'.repeat(43);
    await runTokenActivate({ pat }, { env: { HOME: tmpHome }, rewritePluginJson: rewrite, log: { info: vi.fn() } });

    const envText = readFileSync(path.join(tmpHome, '.plannen', 'profiles', 'default', 'env'), 'utf8');
    expect(envText).toMatch(new RegExp('^MCP_BEARER_TOKEN=' + pat + '$', 'm'));
    expect(rewrite).toHaveBeenCalledOnce();
  });

  it('rejects PATs not starting with plnnn_', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    await expect(runTokenActivate({ pat: 'ghp_garbage' }, { env: { HOME: tmpHome } }))
      .rejects.toThrow(/plnnn_/);
  });

  it('rejects PATs that are too short', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    await expect(runTokenActivate({ pat: 'plnnn_short' }, { env: { HOME: tmpHome } }))
      .rejects.toThrow(/length/i);
  });

  it('does not touch the DB', async () => {
    const { runTokenActivate } = await import('../commands/token/activate.mjs');
    const pat = 'plnnn_' + 'b'.repeat(43);
    await runTokenActivate({ pat }, { env: { HOME: tmpHome }, rewritePluginJson: vi.fn(), log: { info: vi.fn() } });
  });
});
