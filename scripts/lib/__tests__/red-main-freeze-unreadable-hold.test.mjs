// @vitest-environment node
/** @file EMERGENCY-1 (R458): a timed-out freeze read retries once with a longer bound, and an unreadable freeze is its own hold, never "main is red [manual]". */
import { describe, it, expect } from 'vitest';
import { readSharedFreeze, timedGit, drainFreezeSignal, evaluateDrainFreeze, resolveDrainFreezeSettings } from '../red-main-freeze-shared.mjs';
import { decideRedMainHold, redMainHoldReason } from '../red-main-hold.mjs';

const BRANCH = 'ops/red-main-freeze';
const timeoutErr = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });

describe('readSharedFreeze timeout retry', () => {
  it('retries once with a longer bound after ETIMEDOUT and reads the freeze', () => {
    const timeouts = []; let fetches = 0;
    const deadlines = [];
    const mk = (ms, deadlineAt) => (args) => {
      timeouts.push(ms); deadlines.push(deadlineAt);
      if (args[0] === 'fetch' && ++fetches === 1) throw timeoutErr();
      if (args[0] === 'ls-tree') return 'red-main-freeze.json\n';
      if (args[0] === 'show') return JSON.stringify({ frozen: false });
      return '';
    };
    const r = readSharedFreeze({ board: '/b', branch: BRANCH, runFor: mk });
    expect(r).toMatchObject({ frozen: false });
    expect(timeouts[0]).toBeLessThan(timeouts[timeouts.length - 1]);
    expect(new Set(deadlines).size).toBe(1); // one shared deadline for both attempts
    expect(deadlines[0] - Date.now()).toBeLessThanOrEqual(60_000);
  });
  it('still fails closed with a timeout marker when the retry also times out', () => {
    const r = readSharedFreeze({ board: '/b', branch: BRANCH, runFor: () => () => { throw timeoutErr(); } });
    expect(r.error).toMatch(/unreadable/);
    expect(r.error).toMatch(/ETIMEDOUT/);
  });
});

describe('unreadable freeze is its own hold', () => {
  const settings = resolveDrainFreezeSettings({ env: {}, tool: {} });
  const state = evaluateDrainFreeze({ local: null, shared: { error: 'branch unreadable: ETIMEDOUT' }, settings });
  const sig = drainFreezeSignal({ state, mainRedState: null, priority: null, now: Date.now() });
  it('holds, with its own source and reason', () => {
    expect(sig.red).toBe(true);
    expect(sig.sources).toEqual(['freeze-unreadable']);
    const d = decideRedMainHold({ num: 1, signal: sig });
    expect(d.hold).toBe(true);
    expect(d.reason).toMatch(/freeze-unreadable/);
    expect(d.reason).not.toMatch(/main is red/);
    expect(redMainHoldReason(sig)).toMatch(/NOT known red/);
  });
  it('still holds other repos (fail closed)', () => {
    expect(decideRedMainHold({ num: 1, isLocal: false, signal: sig }).hold).toBe(true);
  });
  it('a real manual freeze keeps the manual source', () => {
    const s = evaluateDrainFreeze({ local: { reason: 'x', at: 'y' }, shared: { error: 'e' }, settings });
    expect(drainFreezeSignal({ state: s, mainRedState: null, priority: null, now: Date.now() }).sources).toContain('manual');
  });
});

it('timedGit with the shared deadline cannot run past it', () => {
  const calls = [];
  const exec = (cmd, args, o) => { calls.push(o.timeout); };
  let t = 1000;
  const run = timedGit(40_000, { deadlineAt: 61_000, now: () => t, exec });
  run(['fetch']); t = 50_000; run(['ls-tree']); expect(calls[1]).toBe(11_000);
  t = 61_000; expect(() => run(['show'])).toThrow(/deadline/);
});
