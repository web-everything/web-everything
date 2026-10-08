/**
 * @file scripts/conveyor/health-smells/__tests__/pass-failing-repeatedly.test.mjs
 * @description xkqia1h — the generic `pass-failing-repeatedly` smell and the pass-failure record it reads
 *   (`foldDaemonMemory` → `mem.passFailures`). Reproduces the live 2026-10-08 shape: the lease reaper OOM-crashed
 *   on every pass from ~08:37Z to ~15:57Z (92 crashes, nothing reaped), each crash leaving an UNSTAMPED V8 dump
 *   and a `pass-daemon: … exited on SIGABRT` line in `lease-reaper.log`, and the health watch raised nothing.
 */
import { describe, it, expect } from 'vitest';
import passFailing, { passFailureStreak } from '../pass-failing-repeatedly.mjs';
import { foldDaemonMemory, parsePassFailures, runHealthTick, DEFAULT_HEALTH_CONFIG } from '../../health-watch-core.mjs';
import { SMELLS } from '../index.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-10-08T08:37:00Z');

/** One real crash block from lease-reaper.log (2026-10-08, stack frames trimmed). */
const OOM_BLOCK = [
  '',
  '<--- Last few GCs --->',
  '',
  '[11402:0x140008000]   172929 ms: Mark-Compact 4041.2 (4142.8) -> 4037.6 (4141.7) MB, pooled: 3 MB, 3256.46 / 0.00 ms  (average mu = 0.094, current mu = 0.004) allocation failure; scavenge might not succeed',
  '',
  '<--- JS stacktrace --->',
  '',
  'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
  '----- Native stack trace -----',
  '',
  ' 1: 0x104aaf8e8 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [/Users/x/.nvm/versions/node/v22.1.0/bin/node]',
  '13: 0x104abc784 node::fs::ReadFileUtf8(v8::FunctionCallbackInfo<v8::Value> const&) [/Users/x/.nvm/versions/node/v22.1.0/bin/node]',
  'pass-daemon: scripts/conveyor/lease-reaper.mjs exited on SIGABRT',
  '',
].join('\n');

const HEALTHY_PASS = (iso) => `${iso} lease-reaper: 5 held lease(s) · 0 reaped · 5 kept · PR-axis [we:on] · session-axis on\n`;

/** Feed `chunks` (each `{ at, text }`) through the real fold, one health tick per chunk. */
function foldChunks(chunks, name = 'lease-reaper') {
  let mem;
  let size = 0;
  for (const c of chunks) {
    size += c.text.length + 1;
    mem = foldDaemonMemory(mem, { name, mtimeMs: c.at, sizeBytes: size, text: c.text, bootstrap: false, defaultIntervalMs: 120_000 }, c.at);
  }
  return mem;
}

function evalAt(mem, now, config = {}, name = 'lease-reaper') {
  return passFailing.evaluate({ daemonLogs: [] }, { now, daemons: { [name]: mem }, config: { ...DEFAULT_HEALTH_CONFIG, ...config } });
}

describe('parsePassFailures (the record)', () => {
  it('reads one failure per pass-daemon exit line, naming the last real error line (not a stack frame)', () => {
    const f = parsePassFailures(OOM_BLOCK);
    expect(f).toHaveLength(1);
    expect(f[0].why).toBe('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory');
    expect(f[0].stampMs).toBeNull();
  });

  it('falls back to the exit line itself, and keeps a stamped exit line\'s own time', () => {
    const f = parsePassFailures('2026-10-08T09:00:00.000Z pass-daemon: scripts/conveyor/x.mjs exited with code 1\n');
    expect(f).toEqual([{ stampMs: Date.parse('2026-10-08T09:00:00.000Z'), why: 'pass-daemon: scripts/conveyor/x.mjs exited with code 1' }]);
  });

  it('counts a spawn failure, and never a clean summary or a deprecation warning', () => {
    expect(parsePassFailures('pass-daemon: failed to spawn scripts/conveyor/x.mjs: ENOENT\n')).toHaveLength(1);
    expect(parsePassFailures(`${HEALTHY_PASS('2026-10-08T08:30:00Z')}(node:1) [DEP0040] DeprecationWarning: punycode\n`)).toHaveLength(0);
  });

  it('is folded into the daemon memory, timed by the health tick that saw it', () => {
    const mem = foldChunks([{ at: T0, text: HEALTHY_PASS('2026-10-08T08:36:54Z') }, { at: T0 + 5 * MIN, text: OOM_BLOCK }]);
    expect(mem.passFailures).toEqual([{ at: T0 + 5 * MIN, why: expect.stringMatching(/heap out of memory/) }]);
  });
});

describe('pass-failing-repeatedly (the smell)', () => {
  it('is registered (discovered from disk) as a [high] alert reading daemon logs', () => {
    const s = SMELLS.find((x) => x.id === 'pass-failing-repeatedly');
    expect(s).toBeTruthy();
    expect(s.severity).toBe('high');
    expect(s.probes).toEqual(['daemonLogs']);
  });

  it('2026-10-08 replay: an OOM on every pass breaches at the 3rd consecutive failure, naming the pass and the error', () => {
    const chunks = [{ at: T0 - 2 * MIN, text: HEALTHY_PASS('2026-10-08T08:35:00Z') }];
    for (let i = 1; i <= 3; i += 1) chunks.push({ at: T0 + i * 5 * MIN, text: OOM_BLOCK });
    const after2 = evalAt(foldChunks(chunks.slice(0, 3)), T0 + 10 * MIN);
    expect(after2[0].breach).toBe(false);
    const [r] = evalAt(foldChunks(chunks), T0 + 15 * MIN);
    expect(r.breach).toBe(true);
    expect(r.subject).toBe('lease-reaper');
    expect(r.measure.streak).toBe(3);
    expect(r.summary).toMatch(/lease-reaper/);
    expect(r.summary).toMatch(/heap out of memory/);
  });

  it('stays quiet on healthy passes (no failure lines at all)', () => {
    const chunks = [];
    for (let i = 0; i < 30; i += 1) chunks.push({ at: T0 + i * 2 * MIN, text: HEALTHY_PASS(new Date(T0 + i * 2 * MIN).toISOString()) });
    const out = evalAt(foldChunks(chunks), T0 + 60 * MIN);
    expect(out.every((r) => !r.breach)).toBe(true);
  });

  it('a lone failure followed by a quiet stretch (passes succeeding again) does not breach and ends the streak', () => {
    const mem = foldChunks([{ at: T0, text: OOM_BLOCK }, { at: T0 + 2 * MIN, text: HEALTHY_PASS('2026-10-08T08:39:00Z') }]);
    const [r] = evalAt(mem, T0 + 60 * MIN);
    expect(r.breach).toBe(false);
    expect(r.measure.streak).toBe(0);
  });

  it('two failures separated by a long quiet gap are NOT consecutive', () => {
    const mem = foldChunks([{ at: T0, text: OOM_BLOCK }, { at: T0 + 40 * MIN, text: OOM_BLOCK }, { at: T0 + 80 * MIN, text: OOM_BLOCK }]);
    const s = passFailureStreak(mem, { now: T0 + 80 * MIN, recoverAfterMs: 15 * MIN });
    expect(s.streak).toBe(1);
  });

  it('a slow-cadence pass that keeps failing breaches on "no successful pass in X minutes" before N failures', () => {
    // A 30-minute pass failing every run: only 2 failures in the window, but failing for 30+ minutes.
    let mem;
    const slow = { bootstrap: false, defaultIntervalMs: 30 * MIN, name: 'slow-pass' };
    mem = foldDaemonMemory(mem, { ...slow, mtimeMs: T0, sizeBytes: 10, text: 'slow-pass: ok\n' }, T0);
    mem = foldDaemonMemory(mem, { ...slow, mtimeMs: T0 + 1 * MIN, sizeBytes: 20, text: 'Error: boom\npass-daemon: scripts/conveyor/slow.mjs exited with code 1\n' }, T0 + 1 * MIN);
    mem = foldDaemonMemory(mem, { ...slow, mtimeMs: T0 + 31 * MIN, sizeBytes: 30, text: 'Error: boom\npass-daemon: scripts/conveyor/slow.mjs exited with code 1\n' }, T0 + 31 * MIN);
    const [r] = evalAt(mem, T0 + 32 * MIN, {}, 'slow-pass');
    expect(r.measure.streak).toBe(2);
    expect(r.breach).toBe(true);
    expect(r.measure.trigger).toBe('no-success');
    expect(r.summary).toMatch(/Error: boom/);
  });

  it('N and X are knobs: a higher minStreak holds the alert back', () => {
    const chunks = [];
    for (let i = 1; i <= 3; i += 1) chunks.push({ at: T0 + i * 5 * MIN, text: OOM_BLOCK });
    const [r] = evalAt(foldChunks(chunks), T0 + 15 * MIN, { passFailingMinStreak: 5, passFailingNoSuccessMs: 60 * MIN });
    expect(r.breach).toBe(false);
  });

  it('a dispatcher\'s whole-failed ticks count as failed passes; a clean tick ends the streak', () => {
    const mem = {
      intervalMs: 120_000, passFailures: [],
      recentTicks: [0, 1, 2, 3].map((i) => ({ at: T0 + i * 2 * MIN, u: 1, f: 1, why: 'tick failed: gh-error' })),
    };
    const [r] = evalAt(mem, T0 + 7 * MIN, {}, 'fix-dispatch-daemon');
    expect(r.breach).toBe(true);
    expect(r.measure.streak).toBe(4);
    mem.recentTicks.push({ at: T0 + 8 * MIN, u: 0, f: 0, why: null });
    expect(evalAt(mem, T0 + 9 * MIN, {}, 'fix-dispatch-daemon')[0].breach).toBe(false);
  });

  it('opens an episode through the real tick on the replayed incident', () => {
    let state;
    let size = 0;
    for (let i = 1; i <= 3; i += 1) {
      size += OOM_BLOCK.length;
      const now = T0 + i * 5 * MIN;
      ({ state } = runHealthTick(state, { daemonLogs: [{ name: 'lease-reaper', mtimeMs: now, sizeBytes: size, text: OOM_BLOCK, bootstrap: false, defaultIntervalMs: 120_000 }] },
        [passFailing], now));
    }
    const ep = Object.values(state.episodes || {}).find((e) => e.smell === 'pass-failing-repeatedly');
    expect(ep).toBeTruthy();
    expect(ep.subject).toBe('lease-reaper');
  });
});
