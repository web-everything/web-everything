// @vitest-environment node
import { describe, it, expect } from 'vitest';
import StallWatchdogReporter, {
  DEFAULT_STALL_MS, STALL_ENV, resolveStallMs, effectiveStallMs, stallVerdict, formatStall, descendantPids,
} from '../vitest-stall-watchdog.mjs';

const file = (filepath, state) => ({ filepath, result: state ? { state } : undefined });

describe('resolveStallMs / effectiveStallMs', () => {
  it('defaults, honours a number, disables on 0/off, and keeps the default for junk', () => {
    expect(resolveStallMs({})).toBe(DEFAULT_STALL_MS);
    expect(resolveStallMs({ [STALL_ENV]: '120000' })).toBe(120_000);
    expect(resolveStallMs({ [STALL_ENV]: '0' })).toBe(0);
    expect(resolveStallMs({ [STALL_ENV]: 'off' })).toBe(0);
    expect(resolveStallMs({ [STALL_ENV]: 'soon' })).toBe(DEFAULT_STALL_MS);
    expect(resolveStallMs({ [STALL_ENV]: '-5' })).toBe(DEFAULT_STALL_MS);
  });
  it('never cuts below one test + its hooks + 60s, and stays off when disabled', () => {
    expect(effectiveStallMs(1_000, { testTimeout: 17 * 60_000, hookTimeout: 5 * 60_000 })).toBe(23 * 60_000);
    expect(effectiveStallMs(DEFAULT_STALL_MS, { testTimeout: 5_000, hookTimeout: 10_000 })).toBe(DEFAULT_STALL_MS);
    expect(effectiveStallMs(0, { testTimeout: 5_000 })).toBe(0);
  });
});

describe('stallVerdict', () => {
  const paths = ['/r/a.test.mjs', '/r/b.test.mjs', '/r/c.test.mjs'];
  it('is healthy while activity is recent, even with files unfinished', () => {
    expect(stallVerdict({ paths, files: [], lastActivityMs: 1_000, nowMs: 60_000, stallMs: 60_000 })).toBeNull();
  });
  it('names exactly the files that never finished once idle past the limit (never-collected ones included)', () => {
    const files = [file('/r/a.test.mjs', 'pass'), file('/r/b.test.mjs', 'run')];
    expect(stallVerdict({ paths, files, lastActivityMs: 0, nowMs: 60_000, stallMs: 60_000 }))
      .toEqual({ idleMs: 60_000, unfinished: ['/r/b.test.mjs', '/r/c.test.mjs'] });
  });
  it('is not a stall when every file finished (fail and skip count as finished)', () => {
    const files = [file('/r/a.test.mjs', 'pass'), file('/r/b.test.mjs', 'fail'), file('/r/c.test.mjs', 'skip')];
    expect(stallVerdict({ paths, files, lastActivityMs: 0, nowMs: 10 ** 9, stallMs: 60_000 })).toBeNull();
  });
  it('is off when disabled', () => {
    expect(stallVerdict({ paths, files: [], lastActivityMs: 0, nowMs: 10 ** 9, stallMs: 0 })).toBeNull();
  });
  it('formats root-relative stuck paths', () => {
    expect(formatStall({ idleMs: 61_000, unfinished: ['/r/b.test.mjs'] }, '/r')).toMatch(/61s with 1 file\(s\) unfinished[\s\S]*stuck: b\.test\.mjs/);
  });
});

describe('descendantPids', () => {
  it('collects the whole tree under the root, deepest first, and nothing else', () => {
    const ps = ['1 0', '10 1', '11 10', '12 11', '13 10', '20 1', ''].join('\n');
    expect(descendantPids(ps, 10)).toEqual([12, 11, 13]);
    expect(descendantPids('junk\n', 10)).toEqual([]);
  });
});

describe('StallWatchdogReporter', () => {
  function harness(config = { testTimeout: 5_000, hookTimeout: 10_000, root: '/r' }, env = { [STALL_ENV]: '900000' }) {
    let now = 0; const exits = []; const writes = []; const timers = [];
    let files = [];
    const r = new StallWatchdogReporter({
      env, now: () => now, exit: (c) => exits.push(c), write: (s) => writes.push(s),
      setInterval: (fn, ms) => { const t = { fn, ms, unref() { this.unrefd = true; } }; timers.push(t); return t; },
      clearInterval: (t) => { t.cleared = true; },
    });
    r.onInit({ config, state: { getFiles: () => files } });
    return { r, exits, writes, timers, setNow: (n) => { now = n; }, setFiles: (f) => { files = f; } };
  }
  it('fails a run idle past the limit with files unfinished, once, naming them', () => {
    const h = harness();
    h.r.onPathsCollected(['/r/a.test.mjs', '/r/policy-cascade.test.mjs']);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].unrefd).toBe(true);
    h.setFiles([file('/r/a.test.mjs', 'pass')]);
    h.setNow(900_000 - 1); h.timers[0].fn();
    expect(h.exits).toEqual([]);
    h.setNow(900_000); h.timers[0].fn(); h.timers[0].fn();
    expect(h.exits).toEqual([1]);
    expect(h.writes.join('\n')).toMatch(/stuck: policy-cascade\.test\.mjs/);
    expect(h.timers[0].cleared).toBe(true);
  });
  it('any reporter event resets the idle clock', () => {
    const h = harness();
    h.r.onPathsCollected(['/r/a.test.mjs']);
    h.setNow(800_000); h.r.onTaskUpdate([]);
    h.setNow(1_600_000); h.timers[0].fn();
    expect(h.exits).toEqual([]);
    h.setNow(1_700_000); h.timers[0].fn();
    expect(h.exits).toEqual([1]);
  });
  it('a finished run disarms, and watch mode or WE_VITEST_STALL_MS=off never arms', () => {
    const h = harness();
    h.r.onPathsCollected(['/r/a.test.mjs']);
    h.r.onFinished();
    expect(h.timers[0].cleared).toBe(true);
    const watch = harness({ watch: true, testTimeout: 5_000 });
    watch.r.onPathsCollected(['/r/a.test.mjs']);
    expect(watch.timers).toHaveLength(0);
    const off = harness(undefined, { [STALL_ENV]: 'off' });
    off.r.onPathsCollected(['/r/a.test.mjs']);
    expect(off.timers).toHaveLength(0);
  });
});
