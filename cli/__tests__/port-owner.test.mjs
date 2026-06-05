import { describe, it, expect } from 'vitest';
import { portOwner, describePortSquatter } from '../../scripts/lib/port-owner.mjs';

const lsofOk = (stdout) => () => ({ status: 0, stdout, error: undefined });

describe('portOwner', () => {
  it('parses lsof -F output into pid + command', () => {
    expect(portOwner(54322, lsofOk('p4650\ncssh\nfcwd\n'))).toEqual({ pid: 4650, command: 'ssh' });
  });

  it('returns null when the port is free (lsof exits 1)', () => {
    expect(portOwner(54322, () => ({ status: 1, stdout: '' }))).toBeNull();
  });

  it('returns null when lsof is unavailable (best-effort)', () => {
    expect(portOwner(54322, () => ({ error: new Error('ENOENT'), status: null, stdout: '' }))).toBeNull();
  });

  it('returns null on malformed output', () => {
    expect(portOwner(54322, lsofOk('garbage\n'))).toBeNull();
  });
});

describe('describePortSquatter', () => {
  it('names the owner and port', () => {
    const msg = describePortSquatter(54322, { pid: 1, command: 'nginx' });
    expect(msg).toContain('54322');
    expect(msg).toContain('nginx (pid 1)');
    expect(msg).toContain('different port offset');
  });

  it('hints colima/Docker for ssh forwards', () => {
    expect(describePortSquatter(54322, { pid: 1, command: 'ssh' })).toContain('colima/Docker port-forward');
  });

  it('hints plannen down for an orphaned postgres', () => {
    expect(describePortSquatter(54322, { pid: 1, command: 'postgres' })).toContain('npx plannen down');
  });
});
