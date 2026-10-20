/**
 * @file skills-src/conveyor/__tests__/review-refill.test.mjs
 * @description Card x3mfxzv - shadow refill: setting cascade, debounce, single-flight with the pass, fail-closed
 *   paths, no dispatch ever, and the idle-minutes comparison. Every effect is injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewRefill, createPassLock, resolveRefillMode, shadowOverrides } from '../review-refill.mjs';

const tmpSettings = (obj) => { const p = join(mkdtempSync(join(tmpdir(), 'refill-')), 's.json'); writeFileSync(p, JSON.stringify(obj)); return p; };
const isolatedEnv = (extra = {}) => ({ WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), 'no-such-platform-prefs.json'), ...extra });

function rig({ mode = 'shadow', lives = [], owed = [{ repo: 'o/r', prNumber: 7 }], budgetLeft = 3, plan = null } = {}) {
  let t = 1_000_000;
  const logs = [];
  const timers = [];
  let live = lives[0] ?? 8;
  let liveThrows = false;
  let budgetNull = false;
  const runReview = vi.fn((opts) => {
    if (plan) return plan(opts);
    // stand-in for the pass: dispatch every owed row through the injected dispatch
    for (const o of owed) opts.dispatch({ repo: o.repo, pr: o.prNumber });
    return { repos: [], failed: [], reconcileFailed: [] };
  });
  const r = createReviewRefill({
    runReview,
    budget: () => { if (liveThrows) throw new Error('ps failed'); return budgetNull ? null : { live, left: budgetLeft, max: 8 }; },
    log: (l) => logs.push(l),
    settings: () => ({ mode, source: 'test' }),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; },
    clearTimer: () => {}, setPoll: () => ({ unref() {} }), clearPoll: () => {},
  });
  return {
    r, logs, timers, runReview,
    setLive: (n) => { live = n; }, advance: (ms) => { t += ms; }, setThrow: (b) => { liveThrows = b; }, setBudgetNull: (b) => { budgetNull = b; },
    fire: () => { const h = timers.shift(); h.fn(); },
  };
}

describe('resolveRefillMode', () => {
  it('standard is off with no settings', () => {
    expect(resolveRefillMode({ env: isolatedEnv(), toolPath: '/nonexistent.json' })).toEqual({ mode: 'off', source: 'standard' });
  });
  it('the settings file sets shadow and names its source', () => {
    const r = resolveRefillMode({ env: isolatedEnv(), toolPath: tmpSettings({ refillOnCompletion: 'shadow' }) });
    expect(r.mode).toBe('shadow');
    expect(r.source).not.toBe('standard');
  });
  it('env beats the file; an invalid value never overrides', () => {
    const p = tmpSettings({ refillOnCompletion: 'shadow' });
    expect(resolveRefillMode({ env: isolatedEnv({ WE_REVIEW_REFILL_ON_COMPLETION: 'off' }), toolPath: p }).mode).toBe('off');
    expect(resolveRefillMode({ env: isolatedEnv({ WE_REVIEW_REFILL_ON_COMPLETION: 'bogus' }), toolPath: p }).mode).toBe('shadow');
    expect(resolveRefillMode({ env: isolatedEnv(), toolPath: tmpSettings({ refillOnCompletion: 'bogus' }) }).mode).toBe('off');
  });
  it('a throwing cascade fails closed to off', () => {
    expect(resolveRefillMode({ cascade: () => { throw new Error('x'); } }).mode).toBe('off');
  });
});

describe('shadow refill', () => {
  it('logs would-dispatch after the debounce and never calls a real dispatch', () => {
    const h = rig();
    h.r.poll();                 // seeds live=8
    h.setLive(5); h.advance(1000); h.r.poll();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(15_000);
    expect(h.runReview).not.toHaveBeenCalled(); // nothing before the debounce
    h.fire();
    expect(h.runReview).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => /refill-shadow: would dispatch #7 now \(o\/r; slot freed at .*live 8->5/.test(l))).toBe(true);
  });
  it('the plan runs through the pass code with side effects stripped and the fresh budget', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    const opts = h.runReview.mock.calls[0][0];
    expect(opts.liveReviewBudget.left).toBe(3);
    for (const k of ['tagRound', 'tagStatus', 'notifyReferral', 'finishRedTeamRequest']) expect(opts[k]()).toBeUndefined();
    expect(opts.holdReconcile()).toEqual([]);
    expect(opts.promoteDrafts).toBeNull();
    expect(opts.refreshScopeBloat).toBeNull();
    expect(opts.dispatch({ repo: 'a/b', pr: 1 })).toEqual({ mode: 'shadow', agentId: null });
  });
  it('shadowOverrides records rows only', () => {
    const rec = { rows: [] };
    shadowOverrides(rec, { liveReviewBudget: { left: 1 } }).dispatch({ repo: 'a/b', pr: 9 });
    expect(rec.rows).toEqual([{ repo: 'a/b', prNumber: 9 }]);
  });
  it('several quick exits collapse into one debounced flush', () => {
    const h = rig({ owed: [{ repo: 'o/r', prNumber: 1 }, { repo: 'o/r', prNumber: 2 }, { repo: 'o/r', prNumber: 3 }] });
    h.r.poll(); h.setLive(7); h.r.poll(); h.setLive(5); h.r.poll();
    expect(h.timers).toHaveLength(1);
    h.fire();
    expect(h.runReview).toHaveBeenCalledTimes(1);
    expect(h.logs.filter((l) => l.includes('would dispatch'))).toHaveLength(3);
  });
  it('limits would-dispatch rows to the number of freed slots', () => {
    const h = rig({ owed: [{ repo: 'o/r', prNumber: 1 }, { repo: 'o/r', prNumber: 2 }] });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.logs.filter((l) => l.includes('would dispatch'))).toHaveLength(1);
  });
  it('off mode does nothing at all', () => {
    const h = rig({ mode: 'off' });
    h.r.poll(); h.setLive(2); h.r.poll();
    expect(h.timers).toHaveLength(0);
    expect(h.runReview).not.toHaveBeenCalled();
  });
  it('on mode runs as shadow and says so', () => {
    const h = rig({ mode: 'on' });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.logs.some((l) => /on is not built yet, running as shadow/.test(l))).toBe(true);
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(true);
  });
  it('logs the setting and its source once', () => {
    const h = rig();
    h.r.poll(); h.r.poll(); h.r.poll();
    expect(h.logs.filter((l) => l.startsWith('refill: review.refillOnCompletion=shadow (test)'))).toHaveLength(1);
  });
});

describe('fail closed', () => {
  it('an unreadable process list is not read as a completion', () => {
    const h = rig();
    h.r.poll(); h.setThrow(true); h.r.poll(); h.setThrow(false); h.r.poll();
    expect(h.timers).toHaveLength(0);
  });
  it('an unknown or uncapped budget plans nothing', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.setBudgetNull(true); h.fire();
    expect(h.runReview).not.toHaveBeenCalled();
  });
  it('no free slot in the fresh budget plans nothing', () => {
    const h = rig({ budgetLeft: 0 });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.runReview).not.toHaveBeenCalled();
  });
  it('a failing plan logs and waits for the pass, and releases the lock', () => {
    const h = rig({ plan: () => { throw new Error('gh down'); } });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.logs.some((l) => /plan failed, waiting for the pass: gh down/.test(l))).toBe(true);
    expect(h.r.lock.holder()).toBeNull();
  });
  it('does not replan inside the minimum gap; it retries later', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    h.setLive(6); h.r.poll();
    h.fire();                       // debounce fires inside the 60 s gap
    expect(h.runReview).toHaveBeenCalledTimes(1);
    expect(h.timers).toHaveLength(1); // re-armed
    h.advance(61_000); h.fire();
    expect(h.runReview).toHaveBeenCalledTimes(2);
  });
});

describe('write-free plan and partial answers', () => {
  it('a repo that failed to plan discards the whole answer', () => {
    const h = rig({ plan: (opts) => { opts.dispatch({ repo: 'o/r', pr: 7 }); return { repos: [{ repo: 'x/y', error: 'boom' }], failed: [], reconcileFailed: [] }; } });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(false);
    expect(h.logs.some((l) => /partial or failed/.test(l))).toBe(true);
    expect(h.r.lock.holder()).toBeNull();
  });
  it.each([
    ['reconcileFailed', { repos: [], failed: [], reconcileFailed: [{ repo: 'x', error: 'e' }] }],
    ['failed', { repos: [], failed: [{ error: 'e' }], reconcileFailed: [] }],
    ['a non-object result', undefined],
    ['a result without repos', {}],
  ])('discards on %s', (_n, res) => {
    const h = rig({ plan: (opts) => { opts.dispatch({ repo: 'o/r', pr: 7 }); return res; } });
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.logs.some((l) => l.includes('would dispatch'))).toBe(false);
  });
  it('the reconcile override strips the evidence-cache write and the ledger journal, and keeps the lane reader off', () => {
    const calls = {};
    const rec = { rows: [] };
    const o = shadowOverrides(rec, {
      liveReviewBudget: { left: 1 },
      runReconcile: (x) => { calls.reconcile = x; return { dispatch: [] }; },
      readEvidence: (a) => { calls.evidence = a; return []; },
      referral: (prs, x) => { calls.referral = x.readRuns(); return prs; },
      ledgerStep: (prs, s) => { calls.step = s; return { prs, summary: null }; },
      ledger: (prs, x) => x.step(prs, { repo: 'o/r' }),
    });
    o.reconcile({ repo: 'o/r', defaultBranch: 'main' });
    expect(calls.reconcile.repo).toBe('o/r');
    calls.reconcile.enrichReferralHolds([], { repo: 'o/r' });
    expect(calls.evidence).toEqual({ persist: false });
    calls.reconcile.enrichLedgerHolds([], { repo: 'o/r' });
    expect(calls.step.journal()).toBeUndefined();
    expect(o.acquirableLanes()).toBe(Infinity);
  });
});

describe('single-flight with the pass', () => {
  it('the refill skips while a pass holds the lock and never plans', async () => {
    const h = rig();
    let release;
    const pass = h.r.guardPass(() => new Promise((res) => { release = res; }));
    await Promise.resolve();
    expect(h.r.lock.holder()).toBe('pass');
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    expect(h.runReview).not.toHaveBeenCalled();
    release(); await pass;
    expect(h.r.lock.holder()).toBeNull();
  });
  it('the pass waits for an in-flight refill and then runs; they never overlap', async () => {
    const order = [];
    const lock = createPassLock();
    const relRefill = lock.tryAcquire('refill');
    const pass = lock.acquire('pass').then((rel) => { order.push('pass-start'); rel(); order.push('pass-end'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    order.push('refill-end'); relRefill();
    await pass;
    expect(order).toEqual(['refill-end', 'pass-start', 'pass-end']);
  });
  it('tryAcquire refuses a second holder; release is idempotent', () => {
    const lock = createPassLock();
    const a = lock.tryAcquire('a');
    expect(lock.tryAcquire('b')).toBeNull();
    a(); a();
    expect(lock.tryAcquire('b')).toBeTypeOf('function');
  });
  it('a refill-then-pass run dispatches only through the pass (the refill has no real dispatch)', async () => {
    const h = rig();
    const passDispatch = vi.fn();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    await h.r.guardPass(async () => { passDispatch('o/r#7'); });
    expect(passDispatch).toHaveBeenCalledTimes(1);
  });
});

describe('idle-minutes comparison', () => {
  it('logs minutes saved when the pass dispatches a would-dispatched PR', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    h.advance(10 * 60_000);
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 7 }] });
    expect(h.logs.some((l) => /pass dispatched #7 .* 10\.0 min after .*upper bound.*total 10\.0/.test(l))).toBe(true);
  });
  it('uses the real dispatch time when the pass records one', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    h.advance(10 * 60_000);
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 7, at: 1_000_000 + 4 * 60_000 }] });
    expect(h.logs.some((l) => /4\.0 min after the refill would have;/.test(l))).toBe(true);
  });
  it('ignores PRs it never planned', () => {
    const h = rig();
    h.r.notePass({ dispatched: [{ repo: 'o/r', prNumber: 99 }] });
    expect(h.logs.some((l) => l.includes('pass dispatched'))).toBe(false);
  });
  it('drops a would-dispatch the pass never confirmed', () => {
    const h = rig();
    h.r.poll(); h.setLive(7); h.r.poll(); h.fire();
    h.advance(31 * 60_000);
    h.setLive(6); h.r.poll(); h.fire();
    expect(h.logs.some((l) => /o\/r#7 was never dispatched by a pass within 30 min/.test(l))).toBe(true);
  });
});
