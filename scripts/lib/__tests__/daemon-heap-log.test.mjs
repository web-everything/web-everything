import { describe, it, expect, vi } from 'vitest';
import { logDaemonHeap, resolveDaemonHeapLog, buildHeapRecord } from '../daemon-heap-log.mjs';

const usage = () => ({ heapUsed: 10 * 1048576, heapTotal: 20 * 1048576, rss: 30 * 1048576, external: 5 * 1048576 });
const noFile = { WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prefs.json' };

describe('daemon heap log (R368)', () => {
  it('emits one structured line with the required fields, on by default', () => {
    const lines = [];
    const rec = logDaemonHeap({ daemon: 'review-daemon', pass: 3, passMs: 1234.4, log: { error: (l) => lines.push(l) }, env: noFile, memoryUsage: usage, now: () => new Date('2026-11-01T00:00:00Z') });
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('review-daemon: heap ')).toBe(true);
    const parsed = JSON.parse(lines[0].slice('review-daemon: heap '.length));
    expect(parsed).toEqual({ at: '2026-11-01T00:00:00.000Z', daemon: 'review-daemon', pass: 3, heapUsedMb: 10, heapTotalMb: 20, rssMb: 30, externalMb: 5, passMs: 1234 });
    expect(rec).toEqual(parsed);
  });
  it('stops when switched off by env', () => {
    const lines = [];
    expect(logDaemonHeap({ daemon: 'x', pass: 1, passMs: 1, log: { error: (l) => lines.push(l) }, env: { ...noFile, WE_DAEMON_HEAP_LOG: '0' }, memoryUsage: usage })).toBeNull();
    expect(lines).toEqual([]);
  });
  it('keeps the default for a malformed env value and never throws', () => {
    expect(resolveDaemonHeapLog({ ...noFile, WE_DAEMON_HEAP_LOG: 'maybe' }).enabled).toBe(true);
    expect(logDaemonHeap({ daemon: 'x', pass: 1, passMs: 1, log: { error: () => { throw new Error('x'); } }, env: noFile, memoryUsage: usage })).toBeNull();
  });
  it('buildHeapRecord tolerates a missing passMs', () => {
    expect(buildHeapRecord({ daemon: 'd', pass: 1, passMs: undefined, usage: usage() }).passMs).toBeNull();
  });
});
