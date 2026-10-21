/** Card 308: full-slot admission must be bounded and retryable without executing GitHub. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireGhSlotSync, ghSlotWaitClass, ghSlotWaitMs, GH_SLOT_WAIT_STANDARD, resolveGhSlotWait, runGhSync, runGhCliPassthrough, isGhThrottled } from '../gh-throttle.mjs';
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
