import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDaemonLog, stripLogTimestamp, stampLines, timestampsEnabled } from '../daemon-log.mjs';
import { parseDaemonLog } from '../../../scripts/conveyor/health-watch-core.mjs';
import { foldPrAttempts } from '../../../scripts/conveyor/health-pr-attempts.mjs';
import { liveProcessRefusals } from '../../../scripts/conveyor/health-smells/live-process-stale-transcript.mjs';

const FIXTURE = [
  'review-daemon: started on host, tick every 60000ms',
  'review-daemon: reconcile-refused draft web-everything/web-everything PR #7 — draft: author still working',
  'review-daemon: reconcile-refused live-process web-everything/web-everything PR #8 — pid live',
  'review-daemon: refused missing-run web-everything/web-everything PR #9 — no run',
  'review-daemon: web-everything/web-everything#10 failed (non-fatal): boom',
  'review-daemon: tick (web-everything/web-everything) — dispatched 0, refused 3',
];
const TS = '2026-10-05T22:30:00.000Z ';
const stamp = (lines) => lines.map((l) => TS + l);

function fakeConsole() {
  const out = [];
  const c = { log: (s) => out.push(s), info: (s) => out.push(s), warn: (s) => out.push(s), error: (s) => out.push(s) };
  return { c, out };
}

describe('installDaemonLog', () => {
  it('stamps every line of every console method, including multi-line messages', () => {
    const { c, out } = fakeConsole();
    installDaemonLog({ target: c, env: {}, now: () => new Date('2026-10-05T22:30:00.000Z') });
    c.log('review-daemon: tick %d', 1);
    c.error('review-daemon: a\nreview-daemon: b');
    c.warn('review-daemon: w');
    c.info('review-daemon: i');
    expect(out.join('\n').split('\n')).toHaveLength(5);
    for (const l of out.join('\n').split('\n')) expect(l).toMatch(/^\d{4}-\d\d-\d\dT\S+Z review-daemon: /);
    expect(out[0]).toBe(`${TS}review-daemon: tick 1`);
  });
  it('is idempotent and can be turned off by WE_DAEMON_LOG_TIMESTAMPS=0', () => {
    const a = fakeConsole();
    installDaemonLog({ target: a.c, env: {} });
    installDaemonLog({ target: a.c, env: {} });
    a.c.log('x');
    expect(a.out[0].match(/\d{4}-\d\d-\d\dT/g)).toHaveLength(1);
    const b = fakeConsole();
    installDaemonLog({ target: b.c, env: { WE_DAEMON_LOG_TIMESTAMPS: '0' } });
    b.c.log('x');
    expect(b.out[0]).toBe('x');
    expect(timestampsEnabled({ WE_DAEMON_LOG_TIMESTAMPS: 'off' })).toBe(false);
    expect(timestampsEnabled({})).toBe(true);
  });
  it('strips only a leading stamp', () => {
    expect(stripLogTimestamp(`${TS}review-daemon: x`)).toBe('review-daemon: x');
    expect(stripLogTimestamp('review-daemon: x')).toBe('review-daemon: x');
    expect(stampLines('a\nb', new Date(0))).toBe('1970-01-01T00:00:00.000Z a\n1970-01-01T00:00:00.000Z b');
  });
});

describe('every daemon main() installs the stamp', () => {
  for (const f of ['review-daemon', 'reconcile-fix-dispatch-daemon', 'verify-daemon', 'pass-daemon']) {
    it(f, () => {
      const src = readFileSync(join(process.cwd(), 'skills-src/conveyor', `${f}.mjs`), 'utf8');
      expect(src).toMatch(/async function main\([^)]*\) \{\n\s*installDaemonLog\(\)/);
    });
  }
});

describe('health parsers accept stamped lines (same result as unstamped)', () => {
  const plain = FIXTURE.join('\n');
  const stamped = stamp(FIXTURE).join('\n');
  const mixed = [...FIXTURE.slice(0, 3), ...stamp(FIXTURE.slice(3))].join('\n');
  it('parseDaemonLog', () => {
    const base = parseDaemonLog(plain);
    expect(base.ticks.length).toBe(1);
    expect(base.restarts).toBe(1);
    expect(parseDaemonLog(stamped)).toEqual(base);
    expect(parseDaemonLog(mixed)).toEqual(base);
  });
  it('foldPrAttempts', () => {
    const now = Date.now();
    const run = (text) => foldPrAttempts([], { text, mtimeMs: now }, now, 60000);
    const base = run(plain);
    expect(base.length).toBeGreaterThan(0);
    expect(run(stamped)).toEqual(base);
    expect(run(mixed)).toEqual(base);
  });
  it('live-process refusal count', () => {
    const n = (text) => liveProcessRefusals([{ text }]);
    expect(n(stamped)).toEqual(n(plain));
    expect(n(plain)).toEqual([{ repo: 'web-everything/web-everything', pr: 8, count: 1 }]);
  });
});
