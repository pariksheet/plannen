import { describe, it, expect } from 'vitest';
import {
  LOCAL_ONLY,
  collectCloudTools,
  collectLocalTools,
  diffTools,
  extractToolNames,
} from '../../scripts/check-mcp-parity.mjs';

describe('extractToolNames', () => {
  it('extracts standalone-line tool names, ignores inline name fields', () => {
    const src = [
      `  serverInfo: { name: 'plannen', version: '1.0.0' },`,
      `    name: 'list_events',`,
      `    description: 'x',`,
      `    name: 'create_event',`,
      `    name: 'list_events',`, // dupes collapse
    ].join('\n');
    expect(extractToolNames(src)).toEqual(['create_event', 'list_events']);
  });
});

describe('diffTools', () => {
  it('flags drift in both directions and stale allowlist entries', () => {
    const res = diffTools(['a', 'b', 'mirrored'], ['b', 'c', 'mirrored'], {
      mirrored: 'no longer true',
      gone: 'tool was deleted',
    });
    expect(res.localOnly).toEqual(['a']);
    expect(res.cloudOnly).toEqual(['c']);
    expect(res.staleAllowlist.sort()).toEqual(['gone', 'mirrored']);
    expect(res.ok).toBe(false);
  });

  it('passes when the only gaps are allowlisted', () => {
    const res = diffTools(['a', 'local_thing'], ['a'], { local_thing: 'host binary' });
    expect(res.ok).toBe(true);
  });
});

describe('repo MCP tool parity (#15)', () => {
  it('local stdio and cloud edge declare the same tools (modulo LOCAL_ONLY)', () => {
    const local = collectLocalTools();
    const cloud = collectCloudTools();
    // Sanity: extraction actually found the tool registries.
    expect(local.length).toBeGreaterThan(40);
    expect(cloud.length).toBeGreaterThan(40);
    const res = diffTools(local, cloud, LOCAL_ONLY);
    expect(res.localOnly, `missing from cloud edge: ${res.localOnly}`).toEqual([]);
    expect(res.cloudOnly, `missing from local stdio: ${res.cloudOnly}`).toEqual([]);
    expect(res.staleAllowlist, `stale LOCAL_ONLY entries: ${res.staleAllowlist}`).toEqual([]);
  });
});
