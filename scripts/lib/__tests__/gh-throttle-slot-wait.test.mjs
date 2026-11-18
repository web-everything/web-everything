/** Card 308: full-slot admission must be bounded and retryable without executing GitHub. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseGhSlotSync, acquireGhSlotSync, ghSlotWaitClass, ghSlotWaitMs, GH_SLOT_WAIT_STANDARD, resolveGhSlotWait, runGhSync, runGhCliPassthrough, isGhThrottled } from '../gh-throttle.mjs';
import { isGhThrottled as sharedIsGhThrottled } from '../gh-deferred.mjs';

const dirs = [];
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'gh-slot-wait-')); dirs.push(p); return p; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const READ = ['pr', 'list'];
function fullPool(caller = 'lane-pool-health-watch-we', env = {}) {
  const lockRoot = temp();
  let clock = Date.now();
  const start = clock;
  expect(acquireGhSlotSync({ lockRoot, cap: 1, owner: `${process.pid}:holder`, pid: process.pid, now: () => clock, timeoutMs: 0 }).ok).toBe(true);
  // Keep the pool full for the entire wait budget; holder reaping is covered by gh-throttle-holders.test.mjs.
  const throttle = { lockRoot, cap: 1, caller, env: { WE_PLATFORM_PREFERENCES_FILE: join(lockRoot, 'absent.json'), WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_MAX_HOLD_SECONDS: '0', ...env }, logPath: join(lockRoot, 'calls.jsonl'), now: () => clock, sleep: vi.fn(ms => { clock += ms; }), pollMs: 1000, warn: vi.fn(), exec: vi.fn(() => '[]') };
  return { throttle, elapsed: () => clock - start, rows: () => readFileSync(throttle.logPath, 'utf8').trim().split('\n').map(JSON.parse) };
}

const FREEZE_ARGS = ['api', '-i', 'repos/o/r/git/ref/heads/main'];
describe('ghSlotWaitClass', () => {
  it.each([
    ['unknown', ['pr', 'edit', '1', '--add-label', 'x'], 'priority'],
    ['review-daemon.mjs', READ, 'priority'],
    ['ci-red-recovery-watch-we', READ, 'priority'],
    ['reconcile-fix-dispatch-daemon.mjs', READ, 'background'],
    ['lane-pool-health-watch-we', READ, 'background'],
    ['unknown', READ, 'priority'],
    ['we:scripts/health-watch.mjs', READ, 'background'],
  ])('%s => %s', (caller, args, expected) => {
    expect(ghSlotWaitClass({ caller, args, isWrite: false, settings: GH_SLOT_WAIT_STANDARD })).toBe(expected);
  });
  it('accepts settings regexes, ignores invalid entries, and gives priority precedence', () => {
    const settings = { ...GH_SLOT_WAIT_STANDARD, backgroundCallers: ['[', '^custom', '^review-daemon', '^enqueue'] };
    expect(ghSlotWaitClass({ caller: 'custom.mjs', args: READ, settings })).toBe('background');
    expect(ghSlotWaitClass({ caller: 'review-daemon.mjs', args: READ, settings })).toBe('priority');
    expect(ghSlotWaitClass({ caller: 'enqueue-we', args: READ, settings })).toBe('priority');
    expect(ghSlotWaitClass({ caller: 'custom', args: READ, isWrite: true, settings })).toBe('priority');
  });
});

it.each([['lane-pool-health-watch-we', 'background', 8000], ['review-daemon.mjs', 'priority', 120000]])('sync %s waits its class budget then throws outside retries', (caller, cls, waitedMs) => {
  const f = fullPool(caller);
  let error;
  try { runGhSync(READ, { encoding: 'utf8', throttle: f.throttle }); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ status: 1, stdout: '', ghThrottled: { class: cls, waitedMs } });
  expect(error.stderr).toBe(`gh-throttle: throttled — no gh slot within ${waitedMs / 1000}s (class=${cls}); retry next tick\n`);
  expect(isGhThrottled(error)).toBe(true);
  expect(f.elapsed()).toBe(waitedMs);
  expect(f.throttle.exec).not.toHaveBeenCalled();
  expect(f.rows()).toEqual([expect.objectContaining({ outcome: 'slot_throttled', class: cls, waitedMs, caller, op: 'pr list', resource: 'graphql', id: expect.any(String), inv: expect.any(String) })]);
  expect(f.throttle.warn).toHaveBeenCalledWith(error.stderr);
});

it('retains explicit ungated timeout behavior', () => {
  const f = fullPool(undefined, { WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' });
  expect(runGhSync(READ, { throttle: f.throttle })).toBe('[]');
  expect(f.elapsed()).toBe(8000);
  expect(f.throttle.exec).toHaveBeenCalledTimes(1);
  expect(f.rows().some(r => r.outcome === 'slot_timeout')).toBe(true);
});
it('passthrough returns retryable buffers without spawning', () => {
  const f = fullPool();
  const spawn = vi.fn();
  const result = runGhCliPassthrough(READ, { throttle: f.throttle, spawn });
  expect(result).toMatchObject({ status: 1, throttled: true, stdout: Buffer.alloc(0) });
  expect(isGhThrottled(result.stderr)).toBe(true);
  expect(f.elapsed()).toBe(8000);
  expect(spawn).not.toHaveBeenCalled();
  expect(f.rows()[0]).toMatchObject({ outcome: 'slot_throttled', class: 'background' });
});
it.each(['background', 'priority'])('explicit acquire timeout wins for %s', cls => {
  const f = fullPool(cls === 'background' ? 'health-watch' : 'unknown');
  expect(() => runGhSync(READ, { throttle: { ...f.throttle, acquireTimeoutMs: 2000 } })).toThrow('within 2s');
  expect(f.elapsed()).toBe(2000);
});
it('resolves platform and env knobs with sources and invalid fallback', () => {
  const path = join(temp(), 'preferences.json');
  writeFileSync(path, JSON.stringify({ ghThrottleSlotWait: { backgroundCallers: ['[', '^custom'], priorityCallers: ['^urgent'] } }));
  const env = { WE_PLATFORM_PREFERENCES_FILE: path };
  const settings = resolveGhSlotWait({ ...env, WE_GH_THROTTLE_BACKGROUND_WAIT_MS: '0', WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' });
  expect(settings).toMatchObject({ backgroundWaitMs: 0, onSlotTimeout: 'ungated', source: { backgroundWaitMs: 'env', onSlotTimeout: 'env', backgroundCallers: 'platform', priorityCallers: 'platform' } });
  expect(ghSlotWaitClass({ caller: 'custom', args: READ, settings })).toBe('background');
  for (const bad of ['-1', '120001', '1.5', 'no', '']) {
    expect(resolveGhSlotWait({ ...env, WE_GH_THROTTLE_BACKGROUND_WAIT_MS: bad, WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'bad' })).toMatchObject({ backgroundWaitMs: 8000, onSlotTimeout: 'throttled', source: { backgroundWaitMs: 'standard', onSlotTimeout: 'standard' } });
  }
  expect(resolveGhSlotWait(null)).toMatchObject(GH_SLOT_WAIT_STANDARD);
  expect(resolveGhSlotWait({ WE_PLATFORM_PREFERENCES_FILE: join(temp(), 'absent.json') })).toMatchObject(GH_SLOT_WAIT_STANDARD);
});

describe('per-caller background slot wait (callerWaitMs cascade, operator 2026-10-20)', () => {
  const absent = () => ({ WE_PLATFORM_PREFERENCES_FILE: join(temp(), 'absent.json') });
  const CONFLICT = 'parked-pr-conflict-watch-we';
  it('standard: no caller override, so the conflict watch waits the standard 8 s background budget', () => {
    expect(GH_SLOT_WAIT_STANDARD.callerWaitMs).toEqual({});
    const settings = resolveGhSlotWait(absent(), { tool: {} });
    expect(ghSlotWaitClass({ caller: CONFLICT, args: READ, settings })).toBe('background');
    expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings })).toEqual({ waitMs: 8000, source: 'standard', key: 'backgroundWaitMs' });
  });
  it('the checked-in tool layer gives the conflict watch 120 s, logged as source=tool, still background class', () => {
    const settings = resolveGhSlotWait(absent());
    expect(settings.source['callerWaitMs.^parked-pr-conflict-watch']).toBe('tool');
    expect(ghSlotWaitClass({ caller: CONFLICT, args: READ, settings })).toBe('background');
    expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings }))
      .toEqual({ waitMs: 120000, source: 'tool', key: 'callerWaitMs.^parked-pr-conflict-watch' });
    // Other background callers keep the standard budget.
    expect(ghSlotWaitMs({ caller: 'lane-pool-health-watch-we', waitClass: 'background', settings }).waitMs).toBe(8000);
  });
  it('the checked-in tool layer gives health-watch (stall sweep) and advisory-label-sweep (red-team publish) 60 s, still background', () => {
    const settings = resolveGhSlotWait(absent());
    for (const caller of ['health-watch', 'advisory-label-sweep-we']) {
      expect(ghSlotWaitClass({ caller, args: READ, settings })).toBe('background');
      expect(ghSlotWaitMs({ caller, waitClass: 'background', settings }).waitMs).toBe(60000);
    }
    expect(ghSlotWaitMs({ caller: 'health-watch-other', waitClass: 'background', settings }).waitMs).toBe(8000);
  });
  it('a platform-layer caller wait is named as source=platform, and the tool layer wins over it', () => {
    const path = join(temp(), 'p.json');
    writeFileSync(path, JSON.stringify({ ghThrottleSlotWait: { callerWaitMs: { '^parked-pr-conflict-watch': 60000 } } }));
    const plat = resolveGhSlotWait({ WE_PLATFORM_PREFERENCES_FILE: path }, { tool: {} });
    expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings: plat })).toMatchObject({ waitMs: 60000, source: 'platform' });
    const tool = resolveGhSlotWait({ WE_PLATFORM_PREFERENCES_FILE: path }, { tool: { callerWaitMs: { '^parked-pr-conflict-watch': 90000 } } });
    expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings: tool })).toMatchObject({ waitMs: 90000, source: 'tool' });
  });
  it('bounds: 0 and 120000 are accepted; out-of-range or non-integer values fall back to the standard 8 s', () => {
    for (const ok of [0, 120000]) {
      const settings = resolveGhSlotWait(absent(), { tool: { callerWaitMs: { '^parked-pr-conflict-watch': ok } } });
      expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings })).toMatchObject({ waitMs: ok, source: 'tool' });
    }
    for (const bad of [-1, 120001, 1.5, '120000', null, true, [120000], 1e9]) {
      const settings = resolveGhSlotWait(absent(), { tool: { callerWaitMs: { '^parked-pr-conflict-watch': bad } } });
      expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings }))
        .toEqual({ waitMs: 8000, source: 'standard', key: 'backgroundWaitMs' });
    }
  });
  it('invalid shapes never break a caller: non-object block, malformed regex, priority class untouched', () => {
    for (const tool of [{ callerWaitMs: 120000 }, { callerWaitMs: ['^parked'] }, { callerWaitMs: { '[': 120000 } }]) {
      const settings = resolveGhSlotWait(absent(), { tool });
      expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings }).waitMs).toBe(8000);
    }
    const settings = resolveGhSlotWait(absent(), { tool: { callerWaitMs: { '.*': 0 } } });
    expect(ghSlotWaitMs({ caller: 'review-daemon.mjs', waitClass: 'priority', settings, acquireTimeoutMs: 120000 }).waitMs).toBe(120000);
  });
  it('null input is exactly the standard (no file layers): no caller override survives', () => {
    const standardSources = Object.fromEntries(Object.keys(GH_SLOT_WAIT_STANDARD).map(k => [k, 'standard']));
    for (const input of [null, 'x', 0]) {
      expect(resolveGhSlotWait(input)).toEqual({ ...GH_SLOT_WAIT_STANDARD, source: standardSources });
    }
    expect(resolveGhSlotWait(null).callerWaitMs).toEqual({});
    expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings: resolveGhSlotWait(null) }).waitMs).toBe(8000);
    expect(ghSlotWaitMs({ caller: null, waitClass: 'background', settings: null })).toEqual({ waitMs: 8000, source: 'standard', key: 'backgroundWaitMs' });
  });
  it('the env background wait (highest layer) still wins over the tool caller wait', () => {
    for (const [raw, ms] of [['0', 0], ['5000', 5000]]) {
      const settings = resolveGhSlotWait({ ...absent(), WE_GH_THROTTLE_BACKGROUND_WAIT_MS: raw });
      expect(ghSlotWaitMs({ caller: CONFLICT, waitClass: 'background', settings })).toEqual({ waitMs: ms, source: 'env', key: 'backgroundWaitMs' });
    }
  });
  it('the tool layer contributes ONLY callerWaitMs: class lists, onSlotTimeout and backgroundWaitMs stay as on main', () => {
    const settings = resolveGhSlotWait(absent(), { tool: { onSlotTimeout: 'ungated', backgroundWaitMs: 120000,
      priorityCallers: ['^lane-pool-health-watch'], backgroundCallers: [], callerWaitMs: { '^parked-pr-conflict-watch': 120000 } } });
    expect(settings).toMatchObject({ onSlotTimeout: 'throttled', backgroundWaitMs: 8000,
      priorityCallers: GH_SLOT_WAIT_STANDARD.priorityCallers, backgroundCallers: GH_SLOT_WAIT_STANDARD.backgroundCallers });
    expect(settings.source).toMatchObject({ onSlotTimeout: 'standard', backgroundWaitMs: 'standard', priorityCallers: 'standard', backgroundCallers: 'standard' });
    expect(ghSlotWaitClass({ caller: 'lane-pool-health-watch-we', args: READ, settings })).toBe('background');
  });
  it('a full pool makes the conflict watch wait its 120 s tool budget and records the wait source', () => {
    const f = fullPool(CONFLICT);
    let error;
    try { runGhSync(READ, { encoding: 'utf8', throttle: f.throttle }); } catch (e) { error = e; }
    expect(error).toMatchObject({ ghThrottled: { class: 'background', waitedMs: 120000 } });
    expect(f.elapsed()).toBe(120000);
    expect(f.rows()[0]).toMatchObject({ outcome: 'slot_throttled', class: 'background', waitMs: 120000,
      waitSource: 'callerWaitMs.^parked-pr-conflict-watch:tool' });
  });
});
it('recognizes shared throttled markers without confusing deferrals or ordinary failures', () => {
  expect(sharedIsGhThrottled).toBe(isGhThrottled);
  for (const value of [{ ghThrottled: { class: 'background' } }, { throttled: true }, 'gh-throttle: throttled', Buffer.from('gh-throttle: throttled'), { stderr: Buffer.from('gh-throttle: throttled') }]) expect(isGhThrottled(value)).toBe(true);
  for (const value of [null, undefined, new Error('ordinary'), { deferred: true }, 'slot_timeout']) expect(isGhThrottled(value)).toBe(false);
});

describe('reserved priority slot (drain freeze read)', () => {
  const FREEZE = ['api', '-i', 'repos/o/r/git/ref/heads/main'];
  it('a full pool throttles an ordinary read but a reservedSlot read runs at once, with no wait', () => {
    const plain = fullPool('red-main-freeze-read');
    expect(() => runGhSync(FREEZE, { encoding: 'utf8', throttle: plain.throttle })).toThrow(/throttled/);
    const f = fullPool('red-main-freeze-read');
    expect(runGhSync(FREEZE, { encoding: 'utf8', throttle: { ...f.throttle, reservedSlot: true } })).toBe('[]');
    expect(f.elapsed()).toBe(0);
    expect(f.throttle.exec).toHaveBeenCalledTimes(1);
  });
  it('the reserved slot is bounded: a second reserved read waits, then throttles (never exceeds cap + 1)', () => {
    const f = fullPool('red-main-freeze-read');
    const t = { ...f.throttle, reservedSlot: true, acquireTimeoutMs: 3000 };
    expect(acquireGhSlotSync({ lockRoot: t.lockRoot, cap: 2, owner: `${process.pid}:reserved`, pid: process.pid, now: t.now, timeoutMs: 0 }).ok).toBe(true);
    expect(() => runGhSync(FREEZE, { encoding: 'utf8', throttle: t })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
  });
  it('a write never takes the reserved slot', () => {
    const f = fullPool('red-main-freeze-read');
    expect(() => runGhSync(['pr', 'edit', '1', '--add-label', 'x'], { encoding: 'utf8', throttle: { ...f.throttle, reservedSlot: true, acquireTimeoutMs: 3000 } })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
  });
  it('ordinary callers can never take the reserved slot', () => {
    const lockRoot = temp();
    expect(acquireGhSlotSync({ lockRoot, cap: 1, owner: `${process.pid}:a`, pid: process.pid, timeoutMs: 0 }).ok).toBe(true);
    expect(acquireGhSlotSync({ lockRoot, cap: 1, owner: `${process.pid}:b`, pid: process.pid, timeoutMs: 0 }).ok).toBe(false);
  });
  it.each([
    ['another caller', 'review-daemon', FREEZE_ARGS],
    ['a method override', 'red-main-freeze-read', ['api', '-i', '-X', 'DELETE', 'repos/o/r/git/refs/heads/x']],
    ['a body field', 'red-main-freeze-read', ['api', '-i', '-f', 'a=b', 'repos/o/r/issues']],
    ['a repos endpoint outside the freeze reads', 'red-main-freeze-read', ['api', '-i', 'repos/o/r/issues']],
    ['a non-repos endpoint', 'red-main-freeze-read', ['api', '-i', 'user']],
    ['a classifier-missed write (repo delete)', 'red-main-freeze-read', ['repo', 'delete', 'o/r']],
  ])('%s never takes the reserved slot', (_n, caller, args) => {
    const f = fullPool(caller);
    expect(() => runGhSync(args, { encoding: 'utf8', throttle: { ...f.throttle, reservedSlot: true, acquireTimeoutMs: 3000 } })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
  });
  it('a reserved read waits for its slot no longer than its own call timeout', () => {
    const f = fullPool('red-main-freeze-read');
    expect(acquireGhSlotSync({ lockRoot: f.throttle.lockRoot, cap: 2, owner: `${process.pid}:r2`, pid: process.pid, now: f.throttle.now, timeoutMs: 0 }).ok).toBe(true);
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 4000, throttle: { ...f.throttle, reservedSlot: true } })).toThrow(/throttled/);
    expect(f.elapsed()).toBe(4000);
  });
  it('the reserved slot is released after the read, so a following freeze read gets it again', () => {
    const f = fullPool('red-main-freeze-read');
    const t = { ...f.throttle, reservedSlot: true };
    expect(runGhSync(FREEZE_ARGS, { encoding: 'utf8', throttle: t })).toBe('[]');
    expect(runGhSync(FREEZE_ARGS, { encoding: 'utf8', throttle: t })).toBe('[]');
    expect(f.elapsed()).toBe(0);
  });
  it('a reserved read fails closed when the points budget does not clear inside its call bound', () => {
    const f = fullPool('red-main-freeze-read');
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 2000, throttle: { ...f.throttle, reservedSlot: true, budgetPerMin: 0 } })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
    expect(f.elapsed()).toBeLessThanOrEqual(2000);
  });
  it('the child exec timeout is shrunk by the time already spent waiting, so wait + run stays inside the call bound', () => {
    const f = fullPool('red-main-freeze-read');
    const reservedOwner = `${process.pid}:r1`;
    expect(acquireGhSlotSync({ lockRoot: f.throttle.lockRoot, cap: 2, owner: reservedOwner, pid: process.pid, now: f.throttle.now, timeoutMs: 0 }).ok).toBe(true);
    const seen = [];
    let clock = Date.now();
    let freed = false;
    const sleep = vi.fn(ms => { clock += ms; if (!freed && clock - f.throttle.now() >= -1 && sleep.mock.calls.length >= 5) { freed = true; releaseGhSlotSync({ lockRoot: f.throttle.lockRoot, cap: 2, owner: reservedOwner }); } });
    const exec = vi.fn((_a, o) => { seen.push(o.timeout); return '[]'; });
    expect(runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 20000, throttle: { ...f.throttle, reservedSlot: true, exec, now: () => clock, sleep } })).toBe('[]');
    expect(seen[0]).toBeLessThan(20000);
    expect(seen[0]).toBeGreaterThanOrEqual(1);
  });
  it.each([
    ['ungated override', { WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' }],
  ])('a reserved read on the %s is still throttled, never run ungated', (_n, env) => {
    const f = fullPool('red-main-freeze-read', env);
    expect(acquireGhSlotSync({ lockRoot: f.throttle.lockRoot, cap: 2, owner: `${process.pid}:r3`, pid: process.pid, now: f.throttle.now, timeoutMs: 0 }).ok).toBe(true);
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 2000, throttle: { ...f.throttle, reservedSlot: true } })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
  });
  it('a reserved read is throttled, not run ungated, when slot admission itself throws', () => {
    const f = fullPool('red-main-freeze-read');
    const t = { ...f.throttle, reservedSlot: true, lockRoot: join(f.throttle.lockRoot, 'file-not-dir') };
    writeFileSync(t.lockRoot, 'x');
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', throttle: t })).toThrow(/throttled/);
    expect(f.throttle.exec).not.toHaveBeenCalled();
    // the ordinary caller keeps the old fail-open behaviour
    expect(runGhSync(READ, { encoding: 'utf8', throttle: { ...f.throttle, lockRoot: t.lockRoot } })).toBe('[]');
  });
  it('passthrough: an eligible reserved read really spawns (the injected spawn is called) and releases its slot', () => {
    const f = fullPool('red-main-freeze-read');
    const spawn = vi.fn(() => ({ status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }));
    const t = { ...f.throttle, reservedSlot: true };
    const r = runGhCliPassthrough(FREEZE_ARGS, { throttle: t, spawn });
    expect(r).toMatchObject({ status: 0, stdout: Buffer.from('[]') });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2].timeout).toBeLessThanOrEqual(20000);
    runGhCliPassthrough(FREEZE_ARGS, { throttle: t, spawn });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(f.elapsed()).toBe(0);
  });
  it('passthrough: an ordinary read in the same full pool is still throttled without spawning', () => {
    const f = fullPool('red-main-freeze-read');
    const spawn = vi.fn();
    expect(runGhCliPassthrough(FREEZE_ARGS, { throttle: f.throttle, spawn })).toMatchObject({ throttled: true });
    expect(spawn).not.toHaveBeenCalled();
  });
  it('end to end: the real exported passthrough runs a real child process through the reserved slot', () => {
    const f = fullPool('red-main-freeze-read');
    const bin = join(f.throttle.lockRoot, 'fake-gh.sh');
    writeFileSync(bin, '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 });
    const r = runGhCliPassthrough(FREEZE_ARGS, { throttle: { ...f.throttle, reservedSlot: true }, bin });
    expect(r.status).toBe(0);
    expect(String(r.stdout)).toBe('[]');
  });
  it('a reserved read whose call bound is already spent is refused, never run with a 1 ms allowance', () => {
    const f = fullPool('red-main-freeze-read');
    let clock = Date.now();
    // the points gate sleeps past the whole bound before granting
    const t = { ...f.throttle, reservedSlot: true, now: () => clock, sleep: vi.fn(ms => { clock += ms; }) };
    const pre = () => { clock += 3000; };
    const exec = vi.fn(() => { pre(); return '[]'; });
    const spent = { ...t, exec, now: () => { clock += 1500; return clock; } };
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 1000, throttle: spent })).toThrow(/throttled/);
    expect(exec).not.toHaveBeenCalled();
  });
  it('a reserved read makes exactly one attempt: a rate-limit failure is thrown, not retried or slept on', () => {
    const f = fullPool('red-main-freeze-read');
    const exec = vi.fn(() => { throw Object.assign(new Error('HTTP 403: API rate limit exceeded'), { status: 1, stderr: 'HTTP 403: API rate limit exceeded' }); });
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', throttle: { ...f.throttle, reservedSlot: true, exec, env: { ...f.throttle.env, WE_GH_THROTTLE_NO_BUDGET_PROBE: '1' } } })).toThrow(/rate limit/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(f.throttle.sleep).not.toHaveBeenCalled();
  });
  const RL = 'HTTP 403: API rate limit exceeded';
  it('sync: a reserved read that hits primary exhaustion spends NO diagnostic rate_limit probe, but still records the shared block', () => {
    const f = fullPool('red-main-freeze-read');
    const exec = vi.fn(() => { throw Object.assign(new Error(RL), { status: 1, stderr: RL }); });
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 20000, throttle: { ...f.throttle, reservedSlot: true, exec } })).toThrow(/rate limit/);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls.some(([a]) => a.includes('rate_limit'))).toBe(false);
    expect(f.rows().some(r => r.outcome === 'budget_exhausted')).toBe(true);
  });
  it('sync: an injected probeBudget is not consulted for a reserved read either', () => {
    const f = fullPool('red-main-freeze-read');
    const exec = vi.fn(() => { throw Object.assign(new Error(RL), { status: 1, stderr: RL }); });
    const probeBudget = vi.fn(() => '');
    expect(() => runGhSync(FREEZE_ARGS, { encoding: 'utf8', timeout: 20000, throttle: { ...f.throttle, reservedSlot: true, exec, probeBudget } })).toThrow(/rate limit/);
    expect(probeBudget).not.toHaveBeenCalled();
  });
  it('sync: an ordinary read still probes the bucket after primary exhaustion (unchanged)', () => {
    const f = fullPool('lane-pool-health-watch-we', { WE_GH_THROTTLE_ON_SLOT_TIMEOUT: 'ungated' });
    const exec = vi.fn(() => { throw Object.assign(new Error(RL), { status: 1, stderr: RL }); });
    expect(() => runGhSync(READ, { encoding: 'utf8', throttle: { ...f.throttle, exec } })).toThrow(/rate limit/);
    expect(exec.mock.calls.some(([a]) => a.includes('rate_limit'))).toBe(true);
  });
  it('passthrough: a reserved read that hits primary exhaustion spawns once, with no diagnostic probe, and records the block', () => {
    const f = fullPool('red-main-freeze-read');
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(RL) }));
    const r = runGhCliPassthrough(FREEZE_ARGS, { throttle: { ...f.throttle, reservedSlot: true }, spawn });
    expect(r.status).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.rows().some(x => x.outcome === 'budget_exhausted')).toBe(true);
  });
  it('passthrough: an injected probeBudget is not consulted for a reserved read', () => {
    const f = fullPool('red-main-freeze-read');
    const spawn = vi.fn(() => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(RL) }));
    const probeBudget = vi.fn(() => '');
    runGhCliPassthrough(FREEZE_ARGS, { throttle: { ...f.throttle, reservedSlot: true, probeBudget }, spawn });
    expect(probeBudget).not.toHaveBeenCalled();
  });
});
