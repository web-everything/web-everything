// @vitest-environment node
/** @file EMERGENCY-1 (R458): an unreadable (e.g. timed-out) freeze is its own hold reason, never "main is red [manual]". */
import { describe, it, expect } from 'vitest';
import { readSharedFreeze, drainFreezeSignal, evaluateDrainFreeze, resolveDrainFreezeSettings } from '../red-main-freeze-shared.mjs';
import { decideRedMainHold, redMainHoldReason } from '../red-main-hold.mjs';

const BRANCH = 'ops/red-main-freeze';
const timeoutErr = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });

describe('a timed-out freeze read reports an unreadable error (reason only)', () => {
  it('returns {error} naming the timeout; no retry or bound claim', () => {
    const r = readSharedFreeze({ board: '/b', branch: BRANCH, run: () => { throw timeoutErr(); } });
    expect(r.error).toMatch(/unreadable.*ETIMEDOUT/);
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
