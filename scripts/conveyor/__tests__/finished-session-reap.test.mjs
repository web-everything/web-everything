/**
 * @file scripts/conveyor/__tests__/finished-session-reap.test.mjs
 * @description Live case 2026-10-21 13:24Z (#5758/#5729/#5485): fixer sessions stayed alive after their fix claim was
 *   released. Proves the reaper stops only a dispatch-dir session that outlived its fix-end with no claim held, and
 *   holds on every doubt.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  planFinishedSessionReap, runFinishedSessionReap, resolveFinishedSessionReapSettings, isUnderRoot,
  formatFinishedSessionReapLines, FINISHED_SESSION_REAP_STANDARD,
} from '../finished-session-reap.mjs';

const ROOT = '/ws/.operations/dispatch';
const RELEASED = Date.parse('2026-10-21T13:00:00Z');
const NOW = RELEASED + 15 * 60_000;
const note = (over = {}) => ({
  kind: 'released-claim-session-ignored', repo: 'we', prNumber: 5758, pid: 4242, handle: 'abc123',
  cwd: `${ROOT}/0b5c-uuid`, head: 'deadbeefcafe', releasedAtMs: RELEASED, ...over,
});
const plan = (over = {}, o = {}) => planFinishedSessionReap({ note: note(over), nowMs: NOW, afterMs: 10 * 60_000, dispatchRoot: ROOT, pidAlive: true, ...o });
const settings = { enabled: true, afterMinutes: 10, afterMs: 10 * 60_000, sources: {} };

describe('planFinishedSessionReap', () => {
  it('reaps a dispatch-dir session alive 15m after fix-end with no claim', () => {
    expect(plan()).toMatchObject({ decision: 'reap' });
  });
  it.each([
    ['a live fix claim on the PR', {}, { liveClaim: { meta: { who: 'fix-5758' } } }, /live fix claim/],
    ['the claim store unreadable', {}, { claimReadError: 'EACCES' }, /unreadable/],
    ['no fix-end time', { releasedAtMs: undefined }, {}, /no fix-end/],
    ['no handle', { handle: null }, {}, /no session handle/],
    ['no pid', { pid: null }, {}, /no pid/],
    ['a lane cwd', { cwd: '/ws/.lanes/web-everything/lane-3' }, {}, /not a dispatch dir/],
    ['the dispatch root itself', { cwd: ROOT }, {}, /not a dispatch dir/],
    ['a sibling dir with the same prefix', { cwd: `${ROOT}-evil/x` }, {}, /not a dispatch dir/],
    ['the pid already exited', {}, { pidAlive: false }, /already exited/],
    ['the pid could not be probed', {}, { pidAlive: null }, /could not be probed/],
    ['younger than the threshold', { releasedAtMs: NOW - 5 * 60_000 }, {}, /< 10m/],
    ['another note kind', { kind: 'live-process' }, {}, /not a released-claim/],
  ])('holds on %s', (_l, over, o, re) => {
    const p = plan(over, o);
    expect(p.decision).toBe('hold');
    expect(p.reason).toMatch(re);
  });
});

describe('isUnderRoot', () => {
  it('only strict children', () => {
    expect(isUnderRoot(`${ROOT}/a`, ROOT)).toBe(true);
    expect(isUnderRoot(ROOT, ROOT)).toBe(false);
    expect(isUnderRoot(`${ROOT}/../x`, ROOT)).toBe(false);
    expect(isUnderRoot(null, ROOT)).toBe(false);
  });
});

describe('runFinishedSessionReap', () => {
  const deps = (o = {}) => ({ nowMs: NOW, settings, dispatchRoot: ROOT, readClaim: () => null, probePid: () => true, stop: vi.fn(() => ({ stopped: true, alreadyGone: false })), ...o });
  it('stops by listing handle (claude stop), once per session even if noted twice', () => {
    const d = deps();
    const out = runFinishedSessionReap({ notes: [note(), note()], ...d });
    expect(d.stop).toHaveBeenCalledTimes(1);
    expect(d.stop).toHaveBeenCalledWith({ handle: 'abc123' });
    expect(out.rows).toEqual([expect.objectContaining({ decision: 'reap', result: 'stopped', pid: 4242 })]);
    expect(formatFinishedSessionReapLines(out)[0]).toMatch(/finished-session-reap: we PR #5758 pid 4242 .* reap → stopped/);
  });
  it('never stops when a claim is held, in dry-run, or when disabled', () => {
    for (const o of [{ readClaim: () => ({ meta: { who: 'x' } }) }, { dryRun: true }, { settings: { ...settings, enabled: false } }]) {
      const d = deps(o);
      const out = runFinishedSessionReap({ notes: [note()], ...d });
      expect(d.stop).not.toHaveBeenCalled();
      expect(out.rows).toHaveLength(1);
    }
  });
  it('a claim read that throws holds (fail closed); a stop that throws is reported, never thrown', () => {
    const d1 = deps({ readClaim: () => { throw new Error('boom'); } });
    expect(runFinishedSessionReap({ notes: [note()], ...d1 }).rows[0]).toMatchObject({ decision: 'hold' });
    expect(d1.stop).not.toHaveBeenCalled();
    const d2 = deps({ stop: () => { throw new Error('claude stop failed'); } });
    expect(runFinishedSessionReap({ notes: [note()], ...d2 }).rows[0].result).toMatch(/stop-failed/);
  });
  it('ignores other note kinds entirely', () => {
    const d = deps();
    expect(runFinishedSessionReap({ notes: [{ kind: 'awaiting-permission', prNumber: 1 }], ...d }).rows).toEqual([]);
  });
});

describe('resolveFinishedSessionReapSettings — cascade with sources', () => {
  const quiet = { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES_FILE: '/nonexistent/prefs.json' };
  it('standard default 10m, enabled', () => {
    expect(resolveFinishedSessionReapSettings({ env: quiet, file: {} })).toMatchObject({ enabled: true, afterMinutes: FINISHED_SESSION_REAP_STANDARD.afterMinutes, sources: { afterMinutes: 'standard' } });
  });
  it('tool file overrides, env overrides the file, invalid values fall back', () => {
    expect(resolveFinishedSessionReapSettings({ env: quiet, file: { finishedSessionReap: { afterMinutes: 20 } } })).toMatchObject({ afterMinutes: 20, sources: { afterMinutes: 'tool' } });
    expect(resolveFinishedSessionReapSettings({ env: { ...quiet, WE_FINISHED_SESSION_REAP_MINUTES: '30', WE_FINISHED_SESSION_REAP: '0' }, file: { finishedSessionReap: { afterMinutes: 20 } } }))
      .toMatchObject({ afterMinutes: 30, enabled: false, sources: { afterMinutes: 'env', enabled: 'env' } });
    expect(resolveFinishedSessionReapSettings({ env: { ...quiet, WE_FINISHED_SESSION_REAP_MINUTES: '0' }, file: {} })).toMatchObject({ afterMinutes: 10 });
  });
});
