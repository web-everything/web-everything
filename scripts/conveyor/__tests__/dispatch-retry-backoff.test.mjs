import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backoffDelayMs, backoffVerdict, readBackoffSettings, reasonCodeOf } from '../retry-backoff.mjs';
import { recordPrepareFailure, readFailureState, releaseDuePrepareRetries, rearmFalseHolds, completePrepareFailures } from '../prepare-failure-policy.mjs';
import { recordBuildFailure, clearBuildFailure, listBuildBackoffs, rearmBuildFailures } from '../build-dispatch-failures.mjs';
import { runBuildDispatchTick } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';
import { listBuildDispatchClaims, acquireBuildDispatchClaim, releaseBuildDispatchClaim } from '../build-dispatch-claim.mjs';

const S = { baseMs: 1000, maxMs: 5000, maxAttempts: 3 };
const NOT_CONFIRMED = 'dispatch launch not confirmed (missing effect; no running session)';

describe('backoff schedule', () => {
  it('doubles from base, caps at max, exhausts at maxAttempts', () => {
    expect([1, 2, 3, 4, 5].map(n => backoffDelayMs(n, S))).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect(backoffVerdict({ attempts: 2, now: 0, settings: S })).toEqual({ retryAfter: new Date(2000).toISOString(), exhausted: false });
    expect(backoffVerdict({ attempts: 3, now: 0, settings: S })).toEqual({ retryAfter: null, exhausted: true });
  });
  it('reads settings from env with safe defaults', () => {
    expect(readBackoffSettings({})).toEqual({ baseMs: 300000, maxMs: 3600000, maxAttempts: 6 });
    expect(readBackoffSettings({ WE_DISPATCH_RETRY_BASE_MS: '10', WE_DISPATCH_RETRY_MAX_MS: 'x', WE_DISPATCH_RETRY_MAX_ATTEMPTS: '2' })).toEqual({ baseMs: 10, maxMs: 3600000, maxAttempts: 2 });
  });
  it('names reason codes', () => {
    expect(reasonCodeOf(NOT_CONFIRMED)).toBe('launch-not-confirmed');
    expect(reasonCodeOf('dispatch-lane: the dispatching checkout is 4 commit(s) behind')).toBe('checkout-behind-origin');
    expect(reasonCodeOf('Command failed: node run.mjs')).toBe('dispatch-command-failed');
    expect(reasonCodeOf('wrapper-failed')).toBeNull();
  });
});

describe('prepare held failures retry with backoff (item 95)', () => {
  let dir, path, fileCard;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retry-')); path = join(dir, 'f.json'); fileCard = vi.fn(); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const rec = (attempt, now, over = {}) => recordPrepareFailure({ num: '5188', attempt, stage: 'dispatch', evidence: { reason: NOT_CONFIRMED } }, { path, fileCard, now, settings: S, ...over });

  it('holds with a reason code and retryAfter, files no diagnose card, and is released once due', async () => {
    const f = await rec('a', 0);
    expect(f).toMatchObject({ cause: 'dispatch-transient', reasonCode: 'launch-not-confirmed', held: true, attempts: 1, exhausted: false, retryAfter: new Date(1000).toISOString() });
    expect(fileCard).not.toHaveBeenCalled();
    expect(releaseDuePrepareRetries({ path, now: 999 })).toEqual([]);
    expect(releaseDuePrepareRetries({ path, now: 1000 })).toEqual(['5188']);
    expect(Object.values(readFailureState(path).failures)[0]).toMatchObject({ held: false, retry: true });
  });
  it('backs off exponentially across attempts, then stays held (exhausted) and is never auto-released', async () => {
    await rec('a', 0); releaseDuePrepareRetries({ path, now: 1000 });
    expect((await rec('b', 1000)).retryAfter).toBe(new Date(3000).toISOString());
    releaseDuePrepareRetries({ path, now: 3000 });
    const last = await rec('c', 3000);
    expect(last).toMatchObject({ attempts: 3, exhausted: true, held: true, retryAfter: null });
    expect(releaseDuePrepareRetries({ path, now: 1e12 })).toEqual([]);
  });
  it('completion resets the attempt count', async () => {
    await rec('a', 0); completePrepareFailures('5188', path);
    expect((await rec('b', 10)).attempts).toBe(1);
  });
  it('one-shot re-arm clears only launch-not-confirmed holds recorded before the fix', async () => {
    const state = { failures: {
      old: { num: '1', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
      legacy: { num: '2', attempt: 'run abc', cause: 'unknown', evidence: { reason: NOT_CONFIRMED }, held: true },
      fresh: { num: '3', attempt: 'x', recordedAt: '2026-10-07T01:00:00.000Z', cause: 'dispatch-transient', evidence: { reason: NOT_CONFIRMED }, held: true },
      other: { num: '4', attempt: '2026-10-06T17:56:00.000Z', cause: 'unknown', evidence: { reason: 'wrapper-failed' }, held: true },
    }, cards: {} };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, JSON.stringify(state));
    expect(rearmFalseHolds({ path, dryRun: true }).count).toBe(2);
    expect(readFailureState(path).failures.old.held).toBe(true);
    const r = rearmFalseHolds({ path });
    expect(r).toEqual({ count: 2, nums: ['1', '2'] });
    const after = readFailureState(path).failures;
    expect([after.old.held, after.legacy.held, after.fresh.held, after.other.held]).toEqual([false, false, true, true]);
    expect(rearmFalseHolds({ path }).count).toBe(0);
  });
});

describe('build dispatch failures back off and keep their output (item 96)', () => {
  let dir, path;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bretry-')); path = join(dir, 'b.json'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('records output + reason code, withholds during backoff, exhausts, re-arms, clears on success', () => {
    const r1 = recordBuildFailure({ num: '4688', reason: 'launch-died: x', output: 'stderr: boom' }, { path, now: 0, settings: S });
    expect(r1).toMatchObject({ reasonCode: 'launch-died', output: 'stderr: boom', attempts: 1 });
    expect(listBuildBackoffs({ path, now: 500 })).toEqual([expect.objectContaining({ num: '4688', reason: 'dispatch-backoff' })]);
    expect(listBuildBackoffs({ path, now: 1000 })).toEqual([]);
    recordBuildFailure({ num: '4688', reason: '' }, { path, now: 1000, settings: S });
    expect(recordBuildFailure({ num: '4688', reason: '' }, { path, now: 3000, settings: S })).toMatchObject({ exhausted: true, reasonCode: 'empty-failure-output' });
    expect(listBuildBackoffs({ path, now: 1e12 })[0]).toMatchObject({ reason: 'dispatch-backoff-exhausted' });
    expect(rearmBuildFailures({ path }).nums).toEqual(['4688']);
    recordBuildFailure({ num: '4701', reason: 'x' }, { path, now: 0, settings: S });
    expect(clearBuildFailure('4701', { path })).toBe(true);
    expect(listBuildBackoffs({ path, now: 0 })).toEqual([]);
  });

  it('the tick stops re-dispatching a failing card every tick', async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'bdd-bo-'));
    let clock = 0;
    const scope = ['plateau-app:src/a.ts'];
    const effects = (dispatch) => ({
      planTick: () => ({ decisions: { statusLine: 't', counts: { building: 0 }, spawnBuilds: [{ num: '4688', lane: 1 }],
        admission: { queue: [{ num: '4688', scope }], cleared: [{ num: '4688', ready: true }] } }, nextState: { tick: 1, buildGuards: [], launchedNums: [] } }),
      fetchOpenPrs: () => [{ repo: 'plateau-app', prs: [] }],
      listClaims: () => listBuildDispatchClaims({ lockRoot }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      acquireClaim: ({ num, scope: sc }) => acquireBuildDispatchClaim({ num, scope: sc, owner: 'h:1', pid: process.pid, lockRoot }),
      listRunStoreInFlight: () => [], listSettledBuilds: () => [], killSwitch: () => ({ engaged: false }),
      dispatch,
      recordBuildFailure: (o) => recordBuildFailure(o, { path, now: clock, settings: S }),
      clearBuildFailure: ({ num }) => clearBuildFailure(num, { path }),
      listBuildBackoffs: () => listBuildBackoffs({ path, now: clock }),
    });
    try {
      const dispatch = vi.fn(() => ({ dispatching: false, reason: 'Command failed: dispatch-lane', output: 'child said no' }));
      const a = await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(a.failures[0]).toMatchObject({ num: '4688', reasonCode: 'dispatch-command-failed', output: 'child said no', attempts: 1 });
      clock = 500;
      const b = await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(b.buildBackoffs).toEqual([expect.objectContaining({ num: '4688' })]);
      clock = 1000;
      await runBuildDispatchTick({ live: true, effects: effects(dispatch) });
      expect(dispatch).toHaveBeenCalledTimes(2);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });
});
