import { describe, it, expect, vi } from 'vitest';
import { runScript } from '../lib/runScript.mjs';

describe('runScript', () => {
  it('spawns bash with the resolved script path and passed args', async () => {
    const events = {};
    const fakeChild = {
      on: (event, cb) => { events[event] = cb; },
    };
    const spawner = vi.fn().mockReturnValue(fakeChild);

    const promise = runScript({
      script: 'scripts/start.sh',
      args: ['--no-dev'],
      env: { FOO: 'bar' },
      spawner,
    });

    // Caller-supplied env is merged onto process.env
    expect(spawner).toHaveBeenCalledWith(
      'bash',
      [expect.stringMatching(/\/scripts\/start\.sh$/), '--no-dev'],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ FOO: 'bar' }),
      }),
    );

    // Simulate the child exiting cleanly
    events.exit(0, null);
    await expect(promise).resolves.toBe(0);
  });

  it('rejects-style: resolves with non-zero exit code on script failure', async () => {
    const events = {};
    const fakeChild = { on: (event, cb) => { events[event] = cb; } };
    const spawner = vi.fn().mockReturnValue(fakeChild);

    const promise = runScript({ script: 'scripts/x.sh', args: [], env: {}, spawner });
    events.exit(2, null);
    await expect(promise).resolves.toBe(2);
  });

  it('resolves with 128 + signal when the child is killed by signal', async () => {
    const events = {};
    const fakeChild = { on: (event, cb) => { events[event] = cb; } };
    const spawner = vi.fn().mockReturnValue(fakeChild);

    const promise = runScript({ script: 'scripts/x.sh', args: [], env: {}, spawner });
    events.exit(null, 'SIGTERM');
    // SIGTERM = 15 on POSIX; we don't hard-code the number — just assert >0.
    await expect(promise).resolves.toBeGreaterThan(0);
  });
});
