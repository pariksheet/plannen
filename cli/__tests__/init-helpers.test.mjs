import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  envGet,
  envSet,
  mergeEnv,
  versionGe,
  lower,
  pidAlive,
  reconcileMcpPluginJsonToStdio,
} from '../lib/init-helpers.mjs';

function makeLog() {
  const calls = [];
  const push = (lvl) => (msg) => calls.push([lvl, msg]);
  return {
    calls,
    step: push('step'),
    ok: push('ok'),
    warn: push('warn'),
    err: push('err'),
    dim: push('dim'),
  };
}

function fakeRun(status = 0) {
  const calls = [];
  return {
    calls,
    fn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status };
    },
  };
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'plannen-init-helpers-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('envGet', () => {
  it('returns null for a missing file', () => {
    expect(envGet(path.join(tmp, 'nope'), 'X')).toBeNull();
  });

  it('returns null for a missing key', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=1\nB=2\n');
    expect(envGet(f, 'C')).toBeNull();
  });

  it('reads a plain key=value', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=1\nPLANNEN_USER_EMAIL=me@example.com\nB=2\n');
    expect(envGet(f, 'PLANNEN_USER_EMAIL')).toBe('me@example.com');
  });

  it('strips surrounding double quotes', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'DB_URL="postgres://localhost/x"\n');
    expect(envGet(f, 'DB_URL')).toBe('postgres://localhost/x');
  });

  it('strips surrounding single quotes', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, "ANON_KEY='abc'\n");
    expect(envGet(f, 'ANON_KEY')).toBe('abc');
  });

  it('skips comment lines that look like assignments', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, '# A=should-not-match\nA=real\n');
    expect(envGet(f, 'A')).toBe('real');
  });

  it('takes the first match on duplicate keys (bash awk semantics)', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=first\nA=second\n');
    expect(envGet(f, 'A')).toBe('first');
  });

  it('handles values containing = signs', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'JWT=header.body=signature\n');
    expect(envGet(f, 'JWT')).toBe('header.body=signature');
  });
});

describe('envSet', () => {
  it('creates the file when missing', () => {
    const f = path.join(tmp, '.env');
    envSet(f, 'A', '1');
    expect(readFileSync(f, 'utf8')).toBe('A=1\n');
  });

  it('appends a new key without disturbing existing lines', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=1\n# comment\nB=2\n');
    envSet(f, 'C', '3');
    expect(readFileSync(f, 'utf8')).toBe('A=1\n# comment\nB=2\nC=3\n');
  });

  it('replaces an existing key in place', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=1\nB=2\nC=3\n');
    envSet(f, 'B', 'new');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=new\nC=3\n');
  });

  it('appending to a file without a trailing newline adds one cleanly', () => {
    const f = path.join(tmp, '.env');
    writeFileSync(f, 'A=1');
    envSet(f, 'B', '2');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\n');
  });

  it('round-trips with envGet', () => {
    const f = path.join(tmp, '.env');
    envSet(f, 'PLANNEN_TIER', '2');
    envSet(f, 'PLANNEN_USER_EMAIL', 'me@example.com');
    envSet(f, 'PLANNEN_TIER', '1'); // overwrite
    expect(envGet(f, 'PLANNEN_TIER')).toBe('1');
    expect(envGet(f, 'PLANNEN_USER_EMAIL')).toBe('me@example.com');
  });
});

describe('mergeEnv', () => {
  it('copies template when target is missing', () => {
    const tmpl = path.join(tmp, '.env.example');
    const tgt = path.join(tmp, '.env');
    writeFileSync(tmpl, '# header\nA=1\nB=2\n');
    mergeEnv(tmpl, tgt);
    expect(readFileSync(tgt, 'utf8')).toBe('# header\nA=1\nB=2\n');
  });

  it('preserves existing target values verbatim', () => {
    const tmpl = path.join(tmp, '.env.example');
    const tgt = path.join(tmp, '.env');
    writeFileSync(tmpl, 'A=tmpl-a\nB=tmpl-b\n');
    writeFileSync(tgt, 'A=user-a\nB=user-b\n');
    mergeEnv(tmpl, tgt);
    expect(readFileSync(tgt, 'utf8')).toBe('A=user-a\nB=user-b\n');
  });

  it('appends only the keys missing from target', () => {
    const tmpl = path.join(tmp, '.env.example');
    const tgt = path.join(tmp, '.env');
    writeFileSync(tmpl, 'A=tmpl-a\nB=tmpl-b\nC=tmpl-c\n');
    writeFileSync(tgt, 'A=user-a\n');
    mergeEnv(tmpl, tgt);
    const text = readFileSync(tgt, 'utf8');
    expect(text).toContain('A=user-a');
    expect(text).toContain('B=tmpl-b');
    expect(text).toContain('C=tmpl-c');
  });

  it('ignores comments and blank lines in template', () => {
    const tmpl = path.join(tmp, '.env.example');
    const tgt = path.join(tmp, '.env');
    writeFileSync(tmpl, '# c1\n\nA=1\n# c2\nB=2\n');
    writeFileSync(tgt, '');
    mergeEnv(tmpl, tgt);
    const text = readFileSync(tgt, 'utf8');
    expect(text).toMatch(/^A=1\n/);
    expect(text).toContain('B=2');
    expect(text).not.toContain('# c1');
  });
});

describe('versionGe', () => {
  it.each([
    ['1.0.0', '1.0.0', true],
    ['1.2.3', '1.0.0', true],
    ['2.0.0', '1.99.99', true],
    ['1.0.0', '1.0.1', false],
    ['0.9.9', '1.0.0', false],
    ['20.0.0', '20.0', true],
    ['20.10.5', '20.0', true],
    ['v20.10.5', '20.0', true],
    // First three components only — trailing digits ignored.
    ['1.2.3.4', '1.2.3', true],
    // Missing components default to 0.
    ['1.2', '1.0', true],
    ['1', '1.0.0', true],
  ])('versionGe(%s, %s) === %s', (have, need, expected) => {
    expect(versionGe(have, need)).toBe(expected);
  });
});

describe('lower', () => {
  it('lowercases', () => {
    expect(lower('FOO@BAR.COM')).toBe('foo@bar.com');
  });
  it('handles null/undefined', () => {
    expect(lower(null)).toBe('');
    expect(lower(undefined)).toBe('');
  });
});

describe('pidAlive', () => {
  it('returns false for missing pidfile', () => {
    expect(pidAlive(path.join(tmp, 'nope'))).toBe(false);
  });
  it('returns false for empty pidfile', () => {
    const f = path.join(tmp, 'p');
    writeFileSync(f, '');
    expect(pidAlive(f)).toBe(false);
  });
  it('returns false for a non-numeric pidfile', () => {
    const f = path.join(tmp, 'p');
    writeFileSync(f, 'notapid');
    expect(pidAlive(f)).toBe(false);
  });
  it('returns true for our own pid', () => {
    const f = path.join(tmp, 'p');
    writeFileSync(f, `${process.pid}\n`);
    expect(pidAlive(f)).toBe(true);
  });
  it('returns false for a long-dead pid', () => {
    const f = path.join(tmp, 'p');
    writeFileSync(f, '1\n'); // pid 1 exists but kill(1,0) requires perms on most systems
    // Note: kill(1, 0) returns EPERM not ESRCH for non-root, which `process.kill`
    // surfaces as a thrown error → false. That matches the bash `kill -0` exit
    // behaviour too. So pid 1 → false here unless we're root, which CI isn't.
    if (process.getuid && process.getuid() === 0) {
      expect(pidAlive(f)).toBe(true);
    } else {
      expect(pidAlive(f)).toBe(false);
    }
  });
});

describe('reconcileMcpPluginJsonToStdio', () => {
  const httpManifest = JSON.stringify({
    mcpServers: { plannen: { type: 'http', url: 'https://x/functions/v1/mcp' } },
  });
  const stdioManifest = JSON.stringify({
    mcpServers: { plannen: { command: 'node', args: ['x/index.js'] } },
  });

  it('resets http plugin.json to stdio when target tier is 0', () => {
    const pluginJsonPath = path.join(tmp, 'plugin.json');
    writeFileSync(pluginJsonPath, httpManifest);
    const log = makeLog();
    const run = fakeRun(0);
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath, targetTier: '0', repoRoot: tmp, log, run: run.fn,
    });
    expect(result).toEqual({ changed: true });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].cmd).toBe('bash');
    expect(run.calls[0].args).toEqual([path.join(tmp, 'scripts/mcp-mode.sh'), 'stdio']);
    expect(log.calls.some(([lvl]) => lvl === 'ok')).toBe(true);
  });

  it('resets http plugin.json to stdio when target tier is 1', () => {
    const pluginJsonPath = path.join(tmp, 'plugin.json');
    writeFileSync(pluginJsonPath, httpManifest);
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath, targetTier: '1', repoRoot: tmp, log: makeLog(), run: fakeRun(0).fn,
    });
    expect(result).toEqual({ changed: true });
  });

  it('skips reset when target tier is 2 (cloud)', () => {
    const pluginJsonPath = path.join(tmp, 'plugin.json');
    writeFileSync(pluginJsonPath, httpManifest);
    const run = fakeRun(0);
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath, targetTier: '2', repoRoot: tmp, log: makeLog(), run: run.fn,
    });
    expect(result).toEqual({ changed: false, reason: 'target-tier-is-cloud' });
    expect(run.calls).toHaveLength(0);
  });

  it('skips when plugin.json is already stdio', () => {
    const pluginJsonPath = path.join(tmp, 'plugin.json');
    writeFileSync(pluginJsonPath, stdioManifest);
    const run = fakeRun(0);
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath, targetTier: '0', repoRoot: tmp, log: makeLog(), run: run.fn,
    });
    expect(result).toEqual({ changed: false, reason: 'already-stdio' });
    expect(run.calls).toHaveLength(0);
  });

  it('skips when plugin.json does not exist', () => {
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath: path.join(tmp, 'missing.json'),
      targetTier: '0', repoRoot: tmp, log: makeLog(), run: fakeRun(0).fn,
    });
    expect(result).toEqual({ changed: false, reason: 'no-plugin-json' });
  });

  it('returns a warn-shaped result when mcp-mode.sh exits non-zero', () => {
    const pluginJsonPath = path.join(tmp, 'plugin.json');
    writeFileSync(pluginJsonPath, httpManifest);
    const log = makeLog();
    const result = reconcileMcpPluginJsonToStdio({
      pluginJsonPath, targetTier: '0', repoRoot: tmp, log, run: fakeRun(1).fn,
    });
    expect(result).toEqual({ changed: false, reason: 'mcp-mode-failed', status: 1 });
    expect(log.calls.some(([lvl, msg]) => lvl === 'warn' && msg.includes('exited 1'))).toBe(true);
  });
});
