// Bundle repair (prototype, 2026-10-21): the supervised overlay-top repair for a daemon clone held on its last-good
// build by an overlay conflict. Pins the trigger thresholds, one repair per clone, the kill switch, the brief never
// carrying a forbidden command, and the escalation path.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentArgv } from '../../operations/dispatch-lane-io.mjs';

import {
  BUNDLE_REPAIR_BOT, BUNDLE_REPAIR_STANDARD, BUNDLE_REPAIR_VALID, HOLD_RULES, assertBriefSafe, cloneName, heldRefs, holdIdFor,
  planBundleRepairs, planReconcile, validateOutcome,
} from '../bundle-repair-core.mjs';
import {
  defaultLock, fillRepairBrief, ledgerPath, outcomePath, readLedger, recordOutcome, repairSettingsEnv, resolveBundleRepairSettings, readHostPlatformBundleRepair,
  runBundleRepairs, workerSpawnEnv,
} from '../bundle-repair-dispatch.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-21T21:00:00Z');
const ROOT = '/ws/wev-review-daemon';
const KEY = '206df80ef82e6401';
const held = (minutesAgo, reason = 'established-overlay-conflict') => ({
  since: NOW - minutesAgo * MIN, reason, failed: 'lane/unfreeze-review-top-1021b, lane/ruling-identity: conflict with main', lastGood: 'a'.repeat(40),
});
const clone = (minutesAgo, o = {}) => ({ cloneKey: KEY, root: ROOT, held: held(minutesAgo), ...o });
const on = (o = {}) => ({ ...BUNDLE_REPAIR_STANDARD, enabled: true, mode: 'live', ...o });

describe('planBundleRepairs — trigger and budget', () => {
  it('does nothing while disabled (the default) or with the kill switch', () => {
    expect(planBundleRepairs({ clones: [clone(60)], settings: BUNDLE_REPAIR_STANDARD, now: NOW }).off).toBe('disabled');
    const k = planBundleRepairs({ clones: [clone(60)], settings: on(), killed: true, now: NOW });
    expect(k.off).toBe('kill-switch');
    expect(k.dispatch).toEqual([]);
  });

  it('waits for the trigger minutes, then dispatches once', () => {
    const under = planBundleRepairs({ clones: [clone(19)], settings: on({ triggerMinutes: 20 }), now: NOW });
    expect(under.dispatch).toEqual([]);
    expect(under.held[0].rule).toBe(HOLD_RULES.UNDER_TRIGGER);
    const over = planBundleRepairs({ clones: [clone(20)], settings: on({ triggerMinutes: 20 }), now: NOW });
    expect(over.dispatch).toHaveLength(1);
    expect(over.dispatch[0]).toMatchObject({ cloneKey: KEY, root: ROOT, name: 'review', refs: ['lane/unfreeze-review-top-1021b', 'lane/ruling-identity'] });
  });

  it('only repairs overlay-conflict holds on selected, known clones', () => {
    const smoke = planBundleRepairs({ clones: [{ cloneKey: KEY, root: ROOT, held: held(60, 'smoke-rejected') }], settings: on(), now: NOW });
    expect(smoke.dispatch).toEqual([]);
    expect(smoke.held[0].rule).toBe(HOLD_RULES.NOT_OVERLAY_HOLD);
    expect(planBundleRepairs({ clones: [{ cloneKey: KEY, root: ROOT, held: held(60, 'pinned-overlay-conflict') }], settings: on(), now: NOW }).dispatch).toHaveLength(1);
    expect(planBundleRepairs({ clones: [clone(60)], settings: on({ clones: ['fix'] }), now: NOW }).held[0].rule).toBe(HOLD_RULES.NOT_SELECTED);
    expect(planBundleRepairs({ clones: [clone(60)], settings: on({ clones: ['review'] }), now: NOW }).dispatch).toHaveLength(1);
    expect(planBundleRepairs({ clones: [clone(60, { root: null })], settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.UNKNOWN_ROOT);
  });

  it('one repair per clone, one attempt per hold, max concurrent', () => {
    const c = clone(60);
    const running = [{ cloneKey: KEY, holdId: 'older', status: 'running' }];
    expect(planBundleRepairs({ clones: [c], ledger: running, settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
    const done = [{ cloneKey: KEY, holdId: holdIdFor(c, c.held), status: 'escalated' }];
    expect(planBundleRepairs({ clones: [c], ledger: done, settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.ONE_PER_HOLD);
    const other = { cloneKey: 'fde6cfdae10394e1', root: '/ws/wev-fix-daemon', held: held(60) };
    const two = planBundleRepairs({ clones: [c, other], settings: on({ maxConcurrent: 1 }), now: NOW });
    expect(two.dispatch).toHaveLength(1);
    expect(two.held[0].rule).toBe(HOLD_RULES.MAX_CONCURRENT);
  });

  it('names clones the way the operator does', () => {
    expect(cloneName('/ws/wev-review-daemon')).toBe('review');
    expect(cloneName('/ws/wev-health-watch')).toBe('health-watch');
    expect(cloneName('/ws/.lanes/we-drain-daemon/code')).toBe('we-drain-code');
    expect(heldRefs({ failed: 'lane/a (PR #12), lane/b: conflict with main' })).toEqual(['lane/a', 'lane/b']);
  });
});

describe('planBundleRepairs — bounded dispatch-failed retries', () => {
  const SHA = 'b'.repeat(40);
  const c = clone(60);
  const prior = (o = {}) => ({
    holdId: holdIdFor(c, c.held), cloneKey: KEY, status: 'dispatch-failed',
    dispatcherSha: 'a'.repeat(40), endedAt: NOW - MIN, dispatchRetries: 0, ...o,
  });
  const plan = (entry, o = {}) => planBundleRepairs({
    clones: [c], ledger: [entry], settings: on({ dispatchRetryBackoffMinutes: 60, maxDispatchRetries: 2 }),
    now: NOW, dispatcherSha: SHA, ...o,
  });
  const expectHeld = (p, reason) => {
    expect(p.dispatch).toEqual([]);
    expect(p.held).toEqual([expect.objectContaining({ rule: HOLD_RULES.ONE_PER_HOLD, reason: expect.stringMatching(reason) })]);
  };

  it('escalated (real repair failure) stays sticky despite a new sha and elapsed backoff', () => {
    expectHeld(plan(prior({ status: 'escalated', endedAt: NOW - 120 * MIN })), /escalated/);
  });

  it('duplicate ledger entries for one hold (dispatch-failed then escalated) stay sticky', () => {
    const e = prior({ endedAt: NOW - 120 * MIN });
    const p = plan(e, { ledger: [e, { ...e, status: 'escalated' }] });
    expect(p.dispatch).toEqual([]);
    expect(p.held).toEqual([expect.objectContaining({ rule: HOLD_RULES.ONE_PER_HOLD })]);
  });

  it.each([[{ corrupt: true }], [''], [42], ['not-a-git-sha'], [['a'.repeat(40)]], ['a'.repeat(41)]])('malformed stored dispatcherSha %j is held, never a sha-retry', (bad) => {
    expectHeld(plan(prior({ dispatcherSha: bad })), /invalid dispatcherSha/);
  });

  it('a dispatch-failed entry with an unpublished escalation alert is held, not replaced', () => {
    expectHeld(plan(prior({ escalationPending: [{ reason: 'dispatch-failed' }] })), /not yet published/);
  });

  it.each([['x'], [{}], [1]])('malformed escalationPending %j holds the retry', (bad) => {
    expectHeld(plan(prior({ escalationPending: bad })), /not yet published/);
  });

  it('a malformed current sha never triggers a sha-retry', () => {
    expectHeld(plan(prior(), { dispatcherSha: 'HEAD~1' }), /unchanged or unavailable/);
  });

  it.each(['cleared', 'repaired', 'shadow'])('%s stays sticky despite a new sha and elapsed backoff', (status) => {
    expectHeld(plan(prior({ status, endedAt: NOW - 120 * MIN })), new RegExp(status));
  });

  it('dispatch-failed + new sha retries before backoff', () => {
    const p = plan(prior());
    expect(p.held).toEqual([]);
    expect(p.dispatch).toEqual([expect.objectContaining({ retryOf: { dispatchRetries: 1, previousStatus: 'dispatch-failed' } })]);
  });

  it('dispatch-failed + same sha before backoff holds with an explanatory reason', () => {
    expectHeld(plan(prior({ dispatcherSha: SHA })), /backoff|sha.*unchanged/i);
  });

  it('dispatch-failed + same sha after backoff retries at the exact boundary', () => {
    const p = plan(prior({ dispatcherSha: SHA, endedAt: NOW - 60 * MIN }));
    expect(p.dispatch).toEqual([expect.objectContaining({ retryOf: { dispatchRetries: 1, previousStatus: 'dispatch-failed' } })]);
  });

  it('legacy entry without dispatcherSha retries on a known sha', () => {
    const entry = prior();
    delete entry.dispatcherSha;
    delete entry.dispatchRetries;
    expect(plan(entry).dispatch).toEqual([expect.objectContaining({ retryOf: { dispatchRetries: 1, previousStatus: 'dispatch-failed' } })]);
  });

  describe.each([
    ['changed sha', {}],
    ['elapsed backoff', { dispatcherSha: SHA, endedAt: NOW - 60 * MIN }],
  ])('retry count evidence with %s', (_trigger, triggerFields) => {
    it.each([
      ['omitted legacy count', {}, 1],
      ['explicit null', { dispatchRetries: null }, null],
      ['explicit undefined', { dispatchRetries: undefined }, null],
      ['negative count', { dispatchRetries: -1 }, null],
      ['fractional count', { dispatchRetries: 0.5 }, null],
      ['zero count', { dispatchRetries: 0 }, 1],
      ['valid positive count', { dispatchRetries: 1 }, 2],
    ])('%s permits only valid or omitted evidence', (_label, countFields, nextCount) => {
      const entry = prior(triggerFields);
      delete entry.dispatchRetries;
      Object.assign(entry, countFields);
      const p = plan(entry);
      if (nextCount === null) expectHeld(p, /invalid dispatchRetries/);
      else {
        expect(p.held).toEqual([]);
        expect(p.dispatch).toEqual([expect.objectContaining({
          retryOf: { dispatchRetries: nextCount, previousStatus: 'dispatch-failed' },
        })]);
      }
    });
  });

  it('maxDispatchRetries 0 never retries even with a changed sha and elapsed backoff', () => {
    expectHeld(plan(prior({ endedAt: NOW - 120 * MIN }), { settings: on({ maxDispatchRetries: 0 }) }), /retr(?:y|ies)|used|limit/i);
  });

  it('null sha never sha-retries; backoff alone decides', () => {
    expectHeld(plan(prior(), { dispatcherSha: null }), /backoff|sha/i);
    expect(plan(prior({ endedAt: NOW - 60 * MIN }), { dispatcherSha: null }).dispatch).toHaveLength(1);
  });

  it('empty sha never sha-retries before backoff', () => {
    expectHeld(plan(prior(), { dispatcherSha: '' }), /backoff|sha/i);
  });

  it.each([
    { dispatchRetries: '0' }, { dispatchRetries: NaN }, { dispatchRetries: Infinity },
    { endedAt: String(NOW - 120 * MIN) }, { endedAt: NaN }, { endedAt: Infinity }, { endedAt: undefined },
  ])('malformed dispatchRetries/endedAt held even with a new sha: %j', (bad) => {
    expectHeld(plan(prior(bad)), /./);
  });

  it('retry eligibility still obeys live-per-clone before one-per-hold', () => {
    const p = plan(prior(), { ledger: [prior(), { cloneKey: KEY, holdId: 'older', status: 'running' }] });
    expect(p.dispatch).toEqual([]);
    expect(p.held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
  });

  it('retry eligibility still obeys maxConcurrent after one-per-hold', () => {
    const p = plan(prior(), { ledger: [prior(), { cloneKey: 'other', holdId: 'other', status: 'running' }] });
    expect(p.dispatch).toEqual([]);
    expect(p.held[0].rule).toBe(HOLD_RULES.MAX_CONCURRENT);
  });

  it('retry never happens in shadow mode, when disabled, or when killed', () => {
    for (const o of [{ settings: on({ mode: 'shadow' }) }, { settings: on({ enabled: false }) }, { killed: true }]) {
      expect(plan(prior(), o).dispatch).toEqual([]);
    }
  });
});

describe('the brief never carries a forbidden command', () => {
  const target = { root: ROOT, name: 'review', holdId: 'review-206df80e-x', refs: ['lane/a', 'lane/b'] };

  it('the real template fills cleanly with no conflict override, no force push, no hook bypass', async () => {
    const { prompt, session } = await fillRepairBrief(target);
    expect(prompt).not.toMatch(/--allow-conflict/);
    expect(prompt).not.toMatch(/push[^\n]*(--force|\s-f\b)/);
    expect(prompt).not.toMatch(/--no-verify/);
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain(`--clone=${ROOT}`);
    expect(prompt).toContain(`--allow-no-pr --by=${BUNDLE_REPAIR_BOT}`);
    expect(prompt).toContain('weakened-twice');
    expect(session).toBe('bundle-repair-review-206df80e-x');
  });

  it('removes the original overlays only AFTER the new top is adopted (the rollback baseline survives a failed load)', async () => {
    const { prompt } = await fillRepairBrief(target);
    const add = prompt.indexOf('daemon-overlay.mjs add');
    const load = prompt.indexOf('daemon-load-overlay.mjs --clone=');
    const removeOriginal = prompt.indexOf('--ref=<ref> --by=');
    expect(add).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(add);
    expect(removeOriginal).toBeGreaterThan(load);
    expect(prompt).toMatch(/remove nothing/);
  });

  it('refuses a brief that carries one', async () => {
    expect(() => assertBriefSafe('node daemon-overlay.mjs add --ref=x --allow-conflict --reason=y')).toThrow(/conflict override/);
    expect(() => assertBriefSafe('LANE_SESSION=s git push --force origin HEAD')).toThrow(/force push/);
    expect(() => assertBriefSafe('git push origin +HEAD:refs/heads/x')).toThrow(/force push/);
    expect(() => assertBriefSafe('git commit --no-verify')).toThrow(/hook bypass/);
    const bad = (r) => `${readFileSync(join(r, 'skills-src/conveyor/bundle-repair-brief.md'), 'utf8')}\nthen add --allow-conflict\n`;
    await expect(fillRepairBrief(target, { readBrief: bad })).rejects.toThrow(/forbidden/);
  });
});

describe('validateOutcome', () => {
  it('two WEAKENED audits can only be recorded as an escalation', () => {
    const audits = [{ verdict: 'WEAKENED' }, { verdict: 'WEAKENED' }, { verdict: 'NOT WEAKENED' }];
    expect(() => validateOutcome({ outcome: 'repaired', top: 'lane/unfreeze-review-top-1021d', audits, detail: 'x' })).toThrow(/weakened-twice/);
    expect(validateOutcome({ outcome: 'escalate', reason: 'weakened-twice', audits, detail: 'x' }).reason).toBe('weakened-twice');
    expect(() => validateOutcome({ outcome: 'repaired', top: 'lane/t', audits: [{ verdict: 'WEAKENED' }], detail: 'x' })).toThrow(/final NOT WEAKENED/);
    expect(() => validateOutcome({ outcome: 'escalate', reason: 'wall-time', audits: [], detail: 'x' })).toThrow(/reason/);
  });
});

describe('planReconcile — the escalation path', () => {
  const c = clone(60);
  const id = holdIdFor(c, c.held);
  const entry = (o = {}) => ({ holdId: id, cloneKey: KEY, root: ROOT, status: 'running', startedAt: NOW - 30 * MIN, deadlineAt: NOW + 90 * MIN, ...o });

  it('hold cleared without an outcome keeps the worker supervised for cleanup', () => {
    expect(planReconcile([entry()], { clones: [{ ...c, held: null }], now: NOW })).toEqual([]);
    expect(planReconcile([entry()], { clones: [{ ...c, held: null }], now: NOW,
      outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }),
    })).toEqual([expect.objectContaining({ status: 'cleared', escalate: null, stop: true })]);
  });
  it('session escalated → stop + escalate with its reason', () => {
    const a = planReconcile([entry()], { clones: [c], now: NOW, outcomeFor: () => ({ outcome: 'escalate', reason: 'unresolvable-conflict', detail: 'd' }) });
    expect(a[0]).toMatchObject({ stop: true, status: 'escalated', escalate: 'unresolvable-conflict' });
  });
  it('a conflict override by the bot → escalate, even when the session said repaired', () => {
    const a = planReconcile([entry()], { clones: [c], now: NOW, overrideFor: () => ({ ref: 'lane/x' }), outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }) });
    expect(a[0].escalate).toBe('conflict-override-used');
  });
  it('a mandatory alert outranks a cleared hold; a clone missing from the probe is not "cleared"', () => {
    const gone = [{ ...c, held: null }];
    expect(planReconcile([entry()], { clones: gone, now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })[0].escalate).toBe('conflict-override-used');
    expect(planReconcile([entry()], { clones: gone, now: NOW, outcomeFor: () => ({ outcome: 'escalate', reason: 'weakened-twice', detail: 'd' }) })[0].escalate).toBe('weakened-twice');
    expect(planReconcile([entry()], { clones: [], now: NOW })).toEqual([]);
    expect(planReconcile([entry({ deadlineAt: NOW })], { clones: [], now: NOW })[0].escalate).toBe('wall-time');
  });
  it('the wall time is never suppressed by a cleared hold or a repaired outcome', () => {
    const late = entry({ deadlineAt: NOW });
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ status: 'cleared', escalate: 'wall-time' });
    expect(planReconcile([late], { clones: [c], now: NOW, outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }) })[0]).toMatchObject({ escalate: 'hold-not-cleared', stop: true });
    // A recorded repair and a cleared hold before the deadline are a clean success.
    expect(planReconcile([entry()], { clones: [{ ...c, held: null }], now: NOW,
      outcomeFor: () => ({ outcome: 'repaired', top: 'lane/x' }),
    })[0].escalate).toBeNull();
  });
  it('round 3: a late repaired outcome is still a wall-time overrun; another hold is not "cleared"; the stop-settled tick is watched', () => {
    const late = entry({ deadlineAt: NOW - MIN });
    const lateRepaired = { outcome: 'repaired', top: 'lane/x', recordedAt: new Date(NOW).toISOString() };
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => lateRepaired })[0].escalate).toBe('wall-time');
    const timely = { ...lateRepaired, recordedAt: new Date(NOW - 2 * MIN).toISOString() };
    expect(planReconcile([late], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => timely })[0].escalate).toBe('wall-time');
    // A worker already stopped before the deadline does not overrun just because observation is later.
    expect(planReconcile([{ ...late, status: 'repaired' }], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => timely })[0]).toMatchObject({ escalate: null, stop: false });
    const smokeHeld = [{ ...c, held: { ...c.held, reason: 'smoke-rejected' } }];
    expect(planReconcile([entry({ status: 'repaired', deadlineAt: NOW })], { clones: smokeHeld, now: NOW })[0]).toMatchObject({ escalate: 'hold-not-cleared' });
    expect(planReconcile([entry({ status: 'repaired' })], { clones: smokeHeld, now: NOW })).toEqual([]);
    const settledNow = entry({ status: 'cleared', stopSettledAt: NOW });
    expect(planReconcile([settledNow], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })[0].escalate).toBe('conflict-override-used');
  });
  it('round 6: a repaired entry whose stop only succeeded on the retry tick still escalates the overrun', () => {
    const r = entry({ status: 'repaired', stopSettledAt: NOW, deadlineAt: NOW - MIN });
    expect(planReconcile([r], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ status: 'cleared', escalate: 'wall-time' });
  });
  it('round 5: a stop that only succeeded on the retry tick still escalates the wall-time overrun', () => {
    const settledNow = entry({ status: 'cleared', stopSettledAt: NOW, deadlineAt: NOW - MIN });
    expect(planReconcile([settledNow], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ escalate: 'wall-time' });
  });
  it('round 4: a session that cannot be stopped escalates wall-time once, cleared or repaired', () => {
    const stuck = entry({ status: 'cleared', stopPending: true, deadlineAt: NOW });
    expect(planReconcile([stuck], { clones: [{ ...c, held: null }], now: NOW })[0]).toMatchObject({ escalate: 'wall-time', stop: true, status: 'cleared' });
    expect(planReconcile([{ ...stuck, escalations: ['wall-time'] }], { clones: [{ ...c, held: null }], now: NOW })).toEqual([]);
    const repairedStuck = entry({ status: 'repaired', stopPending: true, deadlineAt: NOW });
    expect(planReconcile([repairedStuck], { clones: [{ ...c, held: null }], now: NOW })[0].escalate).toBe('wall-time');
    const timely = { outcome: 'repaired', top: 'lane/x', recordedAt: new Date(NOW - MIN).toISOString() };
    expect(planReconcile([repairedStuck], { clones: [{ ...c, held: null }], now: NOW, outcomeFor: () => timely })[0]).toMatchObject({ escalate: 'wall-time', stop: true });
    expect(planReconcile([{ ...repairedStuck, escalations: ['wall-time'] }], {
      clones: [{ ...c, held: null }], now: NOW + MIN, outcomeFor: () => timely,
    }).filter((a) => a.escalate === 'wall-time')).toEqual([]);
    expect(planReconcile([entry()], { clones: [{ ...c, held: undefined }], now: NOW })).toEqual([]);
  });
  it('a settled entry whose stop is still pending is still watched for a conflict override (once)', () => {
    const settled = entry({ status: 'cleared', stopPending: true });
    const a = planReconcile([settled], { clones: [{ ...c, held: null }], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) });
    expect(a[0]).toMatchObject({ escalate: 'conflict-override-used', stop: true });
    expect(planReconcile([{ ...settled, escalations: ['conflict-override-used'] }], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })).toEqual([]);
    expect(planReconcile([{ ...settled, stopPending: false }], { clones: [], now: NOW, overrideFor: () => ({ ref: 'lane/x' }) })).toEqual([]);
  });
  it('wall time → escalate; repaired but still held at the wall time → hold-not-cleared', () => {
    expect(planReconcile([entry({ deadlineAt: NOW })], { clones: [c], now: NOW })[0].escalate).toBe('wall-time');
    expect(planReconcile([entry({ status: 'repaired', deadlineAt: NOW })], { clones: [c], now: NOW })[0]).toMatchObject({ escalate: 'hold-not-cleared', stop: false });
  });
});

describe('planReconcile — deadline enforcement', () => {
  const c = { cloneKey: KEY, root: ROOT, held: held(60) };
  const run = (o = {}) => ({ holdId: 'h', cloneKey: KEY, status: 'running', startedAt: NOW - 130 * MIN, deadlineAt: NOW - 10 * MIN, escalations: [], ...o });
  it('an expired running repair whose wall-time alert was already raised is still ended with reason deadline', () => {
    const a = planReconcile([run({ escalations: ['wall-time'] })], { clones: [c], now: NOW });
    expect(a).toEqual([expect.objectContaining({ holdId: 'h', stop: true, status: 'escalated', escalate: 'deadline' })]);
  });
  it('an expired running repair on a clone missing from the probe is ended too', () => {
    const a = planReconcile([run({ escalations: ['wall-time'] })], { clones: [], now: NOW });
    expect(a[0]).toMatchObject({ status: 'escalated', escalate: 'deadline' });
  });
  it('deadline is a tick-raised reason a session cannot record', async () => {
    const { ESCALATION_REASONS, SESSION_ESCALATION_REASONS } = await import('../bundle-repair-core.mjs');
    expect(ESCALATION_REASONS).toContain('deadline');
    expect(SESSION_ESCALATION_REASONS).not.toContain('deadline');
  });
});

describe('runBundleRepairs (IO shell, every seam injected)', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-repair-'));
    const selfSync = [{ cloneKey: KEY, rebuild: { held: held(60) } }];
    const published = [];
    const dispatched = [];
    const stopped = [];
    const seams = {
      dir, selfSync, now: NOW, root: process.cwd(),
      rootsByKey: async () => new Map([[KEY, ROOT]]),
      killed: () => false,
      overrideFor: () => null,
      dispatch: async (t, o) => { dispatched.push({ t, o }); return { handle: 'h1' }; },
      stop: (e) => { stopped.push(e.holdId); },
      publish: (item) => { published.push(item); },
      log: () => {},
      host: 'test-host',
    };
    return { dir, published, dispatched, stopped, seams };
  };
  const settings = (o) => ({ settingsResolved: { settings: on(o), sources: {}, invalid: [] } });
  const seedDispatchFailure = (dir, o = {}) => {
    const c = clone(60);
    const entry = {
      holdId: holdIdFor(c, c.held), cloneKey: KEY, root: ROOT, name: 'review',
      status: 'dispatch-failed', startedAt: NOW - 2 * MIN, endedAt: NOW - MIN,
      dispatcherSha: 'a'.repeat(40), dispatchRetries: 0, escalations: ['dispatch-failed'], ...o,
    };
    mkdirSync(join(dir, 'bundle-repair'), { recursive: true });
    writeFileSync(ledgerPath(dir), JSON.stringify([entry]));
    return entry;
  };

  it.each([
    ['sha-changed', 'b'.repeat(40), NOW],
    ['backoff', 'a'.repeat(40), NOW + 59 * MIN],
  ])('runBundleRepairs replaces the old entry before launch and logs the retry line (%s)', async (reason, sha, now) => {
    const { dir, seams } = setup();
    const old = seedDispatchFailure(dir);
    const log = vi.fn();
    const resolveDispatcherSha = vi.fn(() => sha);
    let reservation;
    const dispatch = vi.fn(async () => { reservation = readLedger(dir); return { handle: 'retry-handle' }; });
    const s = await runBundleRepairs({ ...seams, now, log, dispatch, resolveDispatcherSha, ...settings({ maxDispatchRetries: 2 }) });
    expect(resolveDispatcherSha).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(s.dispatched).toHaveLength(1);
    expect(reservation).toEqual([expect.objectContaining({
      holdId: old.holdId, status: 'running', launching: true, dispatchRetries: 1, dispatcherSha: sha, escalations: [],
    })]);
    const entries = readLedger(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ holdId: old.holdId, status: 'running', handle: 'retry-handle', dispatchRetries: 1, dispatcherSha: sha });
    const retryLine = `bundle-repair[retry]: relaunching ${entries[0].session} for clone review after dispatch-failed (attempt 1/2, reason ${reason})`;
    const launchedLine = `bundle-repair: launched ${entries[0].session} for clone review`;
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines).toContain(retryLine);
    expect(lines).toContain(launchedLine);
    expect(lines.indexOf(retryLine)).toBeLessThan(lines.indexOf(launchedLine));
  });

  it.each([0, 1, 2, 5])('retries bounded at maxDispatchRetries=%i: exactly N relaunches then held across failing passes', async (maxDispatchRetries) => {
    const { dir, published, seams } = setup();
    const old = seedDispatchFailure(dir);
    const dispatch = vi.fn(async () => { throw Object.assign(new Error('cannot resolve --model'), { notApplied: true }); });
    // Every pass changes sha AND clears backoff; neither may bypass the retry budget.
    for (let pass = 1; pass <= maxDispatchRetries + 1; pass += 1) {
      const sha = String(pass).repeat(40);
      const now = NOW + pass * 60 * MIN;
      const s = await runBundleRepairs({
        ...seams, now, dispatch, resolveDispatcherSha: () => sha,
        ...settings({ maxDispatchRetries, dispatchRetryBackoffMinutes: 60 }),
      });
      expect(dispatch).toHaveBeenCalledTimes(Math.min(pass, maxDispatchRetries));
      const entries = readLedger(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ holdId: old.holdId, status: 'dispatch-failed', dispatchRetries: Math.min(pass, maxDispatchRetries) });
      if (pass <= maxDispatchRetries) {
        expect(s.failed).toHaveLength(1);
        expect(entries[0]).toMatchObject({ dispatcherSha: sha, endedAt: now, escalations: ['dispatch-failed'] });
        expect(s.escalated).toEqual([{ holdId: old.holdId, reason: 'dispatch-failed' }]);
      } else {
        expect(s.held[0]).toMatchObject({ rule: HOLD_RULES.ONE_PER_HOLD, reason: expect.stringMatching(/retr(?:y|ies)|used|limit/i) });
      }
      expect(published).toHaveLength(Math.min(pass, maxDispatchRetries));
    }
  });

  it('every new live reservation records dispatcherSha before dispatch', async () => {
    const { dir, seams } = setup();
    const sha = 'b'.repeat(40);
    let reservation;
    await runBundleRepairs({
      ...seams, resolveDispatcherSha: () => sha, ...settings(),
      dispatch: async () => { reservation = readLedger(dir); return { handle: 'h1' }; },
    });
    expect(reservation).toEqual([expect.objectContaining({ status: 'running', dispatcherSha: sha })]);
    expect(readLedger(dir)[0].dispatcherSha).toBe(sha);
  });

  it('retry starts fresh escalation dedup so a second dispatch failure escalates again', async () => {
    const { dir, seams, published } = setup();
    seedDispatchFailure(dir);
    let reservation;
    const s = await runBundleRepairs({
      ...seams, resolveDispatcherSha: () => 'b'.repeat(40), ...settings(),
      dispatch: async () => {
        reservation = readLedger(dir)[0];
        throw Object.assign(new Error('refusing to start without --model'), { notApplied: true });
      },
    });
    expect(reservation).toMatchObject({ escalations: [], dispatchRetries: 1, dispatcherSha: 'b'.repeat(40) });
    expect(s.escalated).toEqual([{ holdId: reservation.holdId, reason: 'dispatch-failed' }]);
    expect(published).toHaveLength(1);
    expect(readLedger(dir)[0]).toMatchObject({ status: 'dispatch-failed', dispatchRetries: 1, dispatcherSha: 'b'.repeat(40), escalations: ['dispatch-failed'] });
  });

  it('an expired running repair is ended (endReason deadline), its slot freed and an alert raised, in one pass', async () => {
    const { dir, published, dispatched, stopped, seams } = setup();
    const c = clone(60);
    const stale = { holdId: 'older-hold', cloneKey: KEY, root: ROOT, name: 'review', status: 'running', startedAt: NOW - 130 * MIN,
      deadlineAt: NOW - 10 * MIN, escalations: ['wall-time'], session: 's1', handle: 'h0' };
    mkdirSync(join(dir, 'bundle-repair'), { recursive: true });
    writeFileSync(ledgerPath(dir), JSON.stringify([stale]));
    const s = await runBundleRepairs({ ...seams, selfSync: [{ cloneKey: KEY, rebuild: { held: c.held } }], ...settings({ maxConcurrent: 1 }) });
    const e = readLedger(dir).find((x) => x.holdId === 'older-hold');
    expect(e).toMatchObject({ status: 'escalated', endReason: 'deadline', endedAt: NOW });
    expect(stopped).toContain('older-hold');
    expect(s.escalated).toEqual(expect.arrayContaining([{ holdId: 'older-hold', reason: 'deadline' }]));
    expect(published.length).toBeGreaterThan(0);
    expect(dispatched).toHaveLength(1);
  });

  it('unreadable ledger throws and dispatches nothing even with retry enabled and a known sha', async () => {
    const { dir, dispatched, seams } = setup();
    // A directory at the ledger path reliably fails readFileSync, even for a privileged test runner.
    mkdirSync(ledgerPath(dir), { recursive: true });
    await expect(runBundleRepairs({
      ...seams, resolveDispatcherSha: () => 'b'.repeat(40), ...settings({ maxDispatchRetries: 2 }),
    })).rejects.toThrow(/unknown ledger/);
    expect(dispatched).toEqual([]);
  });

  it('unreadable dispatcher sha never causes a sha retry; backoff still retries with null recorded', async () => {
    const { dir, dispatched, seams } = setup();
    seedDispatchFailure(dir);
    const resolveDispatcherSha = () => null;
    const before = await runBundleRepairs({ ...seams, resolveDispatcherSha, ...settings() });
    expect(dispatched).toEqual([]);
    expect(before.held[0].rule).toBe(HOLD_RULES.ONE_PER_HOLD);
    await runBundleRepairs({ ...seams, resolveDispatcherSha, now: NOW + 59 * MIN, ...settings() });
    expect(dispatched).toHaveLength(1);
    expect(readLedger(dir)).toEqual([expect.objectContaining({ dispatcherSha: null, dispatchRetries: 1, status: 'running' })]);
  });

  const repairedOutcome = (dir) => {
    const entry = readLedger(dir)[0];
    mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
    writeFileSync(outcomePath(dir, entry.holdId), JSON.stringify({
      outcome: 'repaired', top: 'lane/repaired', recordedAt: new Date(NOW + MIN).toISOString(),
      audits: [{ verdict: 'NOT WEAKENED' }], detail: 'cleanup complete',
    }));
  };

  it('clearing the hold before the outcome leaves the worker running until cleanup is recorded', async () => {
    const { dir, stopped, dispatched, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const selfSync = [{ cloneKey: KEY, rebuild: { held: null } }];
    const cleaning = await runBundleRepairs({ ...seams, selfSync, now: NOW + MIN, ...settings() });
    expect(cleaning.reconciled).toEqual([]);
    expect(stopped).toEqual([]);
    expect(readLedger(dir)[0]).toMatchObject({ status: 'running', deadlineAt: NOW + 120 * MIN });
    repairedOutcome(dir);
    const done = await runBundleRepairs({ ...seams, selfSync, now: NOW + 2 * MIN, ...settings() });
    expect(done.escalated).toEqual([]);
    expect(stopped).toEqual([readLedger(dir)[0].holdId]);
    expect(readLedger(dir)[0].status).toBe('cleared');
    expect(dispatched).toHaveLength(1);
  });

  it('lane cleanup completes before terminal outcome recording lets the supervisor stop the worker', async () => {
    const { dir, dispatched, seams } = setup();
    const lanes = new Set(['repair', 'verification']);
    const stop = vi.fn(() => { expect([...lanes]).toEqual([]); });
    await runBundleRepairs({ ...seams, stop, ...settings() });
    const { prompt, token } = dispatched[0].o;
    // Pin the actual worker procedure as well as its supervisor lifecycle: cleanup must precede the command
    // that makes the worker eligible to be stopped, for every lane and either terminal outcome.
    const releaseAt = prompt.indexOf('/scripts/lane-pool.mjs release --lane=');
    const recordAt = prompt.indexOf('/scripts/conveyor/bundle-repair-dispatch.mjs record --hold=');
    expect(releaseAt).toBeGreaterThanOrEqual(0);
    expect(recordAt).toBeGreaterThan(releaseAt);
    expect(prompt).toContain('For both repaired and escalated outcomes');
    expect(prompt).toContain('Confirm each release succeeded');
    const selfSync = [{ cloneKey: KEY, rebuild: { held: null } }];
    // A tick while another lane still needs releasing cannot interrupt cleanup.
    lanes.delete('repair');
    await runBundleRepairs({ ...seams, stop, selfSync, now: NOW + MIN, ...settings() });
    expect(stop).not.toHaveBeenCalled();
    expect(existsSync(outcomePath(dir, readLedger(dir)[0].holdId))).toBe(false);
    lanes.delete('verification');
    const entry = readLedger(dir)[0];
    recordOutcome({ dir, holdId: entry.holdId, session: entry.session, token, input: {
      outcome: 'repaired', top: 'lane/repaired', audits: [{ verdict: 'NOT WEAKENED' }], detail: 'all lanes released',
    } });
    await runBundleRepairs({ ...seams, stop, selfSync, now: NOW + 2 * MIN, ...settings() });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(readLedger(dir)[0].status).toBe('cleared');
  });

  it('a timely repaired outcome with persistently failed stops raises exactly one wall-time alert', async () => {
    const { dir, published, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    repairedOutcome(dir);
    const stop = vi.fn(() => { throw Error('worker still running'); });
    await runBundleRepairs({ ...seams, stop, now: NOW + MIN, ...settings() });
    expect(readLedger(dir)[0]).toMatchObject({ status: 'repaired', stopPending: true });
    const selfSync = [{ cloneKey: KEY, rebuild: { held: null } }];
    const overdue = await runBundleRepairs({ ...seams, stop, selfSync, now: NOW + 120 * MIN, ...settings() });
    expect(overdue.escalated).toEqual([{ holdId: readLedger(dir)[0].holdId, reason: 'wall-time' }]);
    const again = await runBundleRepairs({ ...seams, stop, selfSync, now: NOW + 121 * MIN, ...settings() });
    expect(again.escalated).toEqual([]);
    expect(published).toHaveLength(1);
    expect(readLedger(dir)[0]).toMatchObject({ status: 'cleared', stopPending: true, escalations: ['wall-time'] });
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('live: launches ONE session per clone, and a second tick launches none', async () => {
    const { dir, dispatched, seams } = setup();
    const s1 = await runBundleRepairs({ ...seams, ...settings() });
    expect(s1.dispatched).toHaveLength(1);
    expect(dispatched[0].o.prompt).not.toMatch(/--allow-conflict/);
    expect(readLedger(dir)[0]).toMatchObject({ status: 'running', handle: 'h1', deadlineAt: NOW + 120 * MIN });
    const s2 = await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings() });
    expect(s2.dispatched).toEqual([]);
    expect(s2.held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
    expect(dispatched).toHaveLength(1);
  });

  it('kill switch: nothing launched', async () => {
    const { dispatched, seams } = setup();
    const s = await runBundleRepairs({ ...seams, killed: () => true, ...settings() });
    expect(s.off).toBe('kill-switch');
    expect(dispatched).toEqual([]);
  });

  it('shadow: posts the brief it would launch, once per hold, and launches nothing', async () => {
    const { dir, dispatched, published, seams } = setup();
    const s = await runBundleRepairs({ ...seams, ...settings({ mode: 'shadow' }) });
    expect(dispatched).toEqual([]);
    expect(s.shadow).toHaveLength(1);
    const entry = readLedger(dir)[0];
    expect(entry.status).toBe('shadow');
    expect(readFileSync(entry.briefPath, 'utf8')).toContain(`--clone=${ROOT}`);
    expect(published[0]).toMatchObject({ kind: 'bundle-repair-shadow' });
    await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings({ mode: 'shadow' }) });
    expect(published).toHaveLength(1);
  });

  it('escalation: a recorded escalate stops the session and raises ONE needs-you item; never re-dispatched', async () => {
    const { dir, published, stopped, dispatched, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const e = readLedger(dir)[0];
    mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
    writeFileSync(outcomePath(dir, e.holdId), JSON.stringify({ outcome: 'escalate', reason: 'weakened-twice', detail: 'audit said WEAKENED twice' }));
    const s = await runBundleRepairs({ ...seams, now: NOW + 5 * MIN, ...settings() });
    expect(s.escalated).toEqual([{ holdId: e.holdId, reason: 'weakened-twice' }]);
    expect(stopped).toEqual([e.holdId]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: 'bundle-repair', repo: 'host/test-host', pr: 0 });
    expect(published[0].reason).toMatch(/weakened-twice/);
    await runBundleRepairs({ ...seams, now: NOW + 10 * MIN, ...settings() });
    expect(dispatched).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it('reserves the ledger entry BEFORE launching (a crash mid-launch cannot double-launch)', async () => {
    const { dir, seams } = setup();
    let onDisk = null;
    await runBundleRepairs({ ...seams, dispatch: async () => { onDisk = readLedger(dir); throw new Error('crashed mid-launch'); }, ...settings() });
    expect(onDisk).toEqual([expect.objectContaining({ status: 'running', indeterminate: true })]);
    const again = await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings() });
    expect(again.dispatched).toEqual([]);
    expect(again.held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
  });

  it('a failed escalation post is retried next tick, never lost; a failed stop is retried and blocks a new launch', async () => {
    const { dir, published, dispatched, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const e = readLedger(dir)[0];
    mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
    writeFileSync(outcomePath(dir, e.holdId), JSON.stringify({ outcome: 'escalate', reason: 'unresolvable-conflict', detail: 'd' }));
    const failing = { publish: () => { throw new Error('feed down'); }, stop: () => { throw new Error('stop failed'); } };
    await runBundleRepairs({ ...seams, ...failing, now: NOW + MIN, ...settings() });
    const pending = readLedger(dir)[0];
    expect(pending).toMatchObject({ status: 'escalated', stopPending: true, escalationPending: [{ reason: 'unresolvable-conflict' }] });
    // the hold is still there and a later hold id would be new — but a pending stop still counts as a live repair
    const s = await runBundleRepairs({ ...seams, now: NOW + 2 * MIN, ...settings() });
    expect(published).toEqual([expect.objectContaining({ kind: 'bundle-repair' })]);
    const settled = readLedger(dir)[0];
    expect(settled.escalationPending).toBeUndefined();
    expect(settled.stopPending).toBeUndefined();
    expect(s.dispatched).toEqual([]);
    expect(dispatched).toHaveLength(1);
  });

  it('off with nothing recorded leaves no files and takes no lock', async () => {
    const { dir, seams } = setup();
    const s = await runBundleRepairs({ ...seams, lock: () => { throw new Error('must not lock'); }, settingsResolved: { settings: BUNDLE_REPAIR_STANDARD, sources: {}, invalid: [] } });
    expect(s.off).toBe('disabled');
    expect(existsSync(join(dir, 'bundle-repair'))).toBe(false);
  });

  it('the ledger lock: a live holder makes another pass fail closed; a dead holder is taken over once; released after', async () => {
    const { dir, dispatched, seams } = setup();
    const { hostname } = await import('node:os');
    mkdirSync(join(dir, 'bundle-repair'), { recursive: true });
    const lockFile = `${ledgerPath(dir)}.lock`;
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: hostname() })); // a live holder (this process)
    await expect(runBundleRepairs({ ...seams, lock: undefined, ...settings() })).rejects.toThrow(/lock is held/);
    expect(dispatched).toEqual([]);
    writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 30, host: hostname() })); // a dead holder
    const deadLock = (d, fn) => defaultLock(d, fn, { isAlive: () => false });
    await runBundleRepairs({ ...seams, lock: deadLock, ...settings() });
    expect(dispatched).toHaveLength(1);
    expect(existsSync(lockFile)).toBe(false);
    expect(existsSync(`${lockFile}.takeover`)).toBe(false);
    writeFileSync(`${lockFile}.takeover`, 'x'); writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 30, host: hostname() }));
    expect(() => deadLock(dir, () => 'ran')).toThrow(/takeover/);
  });

  it('round 5: an unreadable ledger fails closed (never read as empty)', async () => {
    const { dir, dispatched, seams } = setup();
    mkdirSync(join(dir, 'bundle-repair'), { recursive: true });
    writeFileSync(ledgerPath(dir), '{not json');
    await expect(runBundleRepairs({ ...seams, ...settings() })).rejects.toThrow(/unknown ledger/);
    writeFileSync(ledgerPath(dir), JSON.stringify({ not: 'a list' }));
    await expect(runBundleRepairs({ ...seams, ...settings() })).rejects.toThrow(/unknown ledger/);
    expect(dispatched).toEqual([]);
  });

  it('round 6: an indeterminate late launch on a settled entry is a pending stop, not forgotten', async () => {
    const { dir, seams } = setup();
    await runBundleRepairs({
      ...seams, ...settings(),
      dispatch: async () => {
        const l = readLedger(dir); l[0].status = 'cleared'; writeFileSync(ledgerPath(dir), JSON.stringify(l));
        throw new Error('spawn outcome unknown');
      },
    });
    expect(readLedger(dir)[0]).toMatchObject({ status: 'cleared', stopPending: true });
  });

  it('round 5: a reservation settled by another pass mid-launch gets its late session stopped; the clone stays blocked meanwhile', async () => {
    const { dir, stopped, seams } = setup();
    const s = await runBundleRepairs({
      ...seams, ...settings(),
      dispatch: async () => {
        // another pass settles the reservation while this launch is in flight
        const l = readLedger(dir); l[0].status = 'cleared'; writeFileSync(ledgerPath(dir), JSON.stringify(l));
        return { handle: 'late' };
      },
    });
    expect(s.dispatched).toHaveLength(1);
    expect(readLedger(dir)[0]).toMatchObject({ handle: 'late', status: 'cleared', stopPending: true });
    expect(readLedger(dir)[0].launching).toBeUndefined();
    // next pass: the pending stop runs, then the audit trail is re-read after it
    let stoppedYet = false;
    const next = await runBundleRepairs({
      ...seams, now: NOW + MIN, ...settings(), selfSync: [{ cloneKey: KEY, rebuild: { held: null } }],
      stop: (e) => { stoppedYet = true; stopped.push(e.holdId); }, overrideFor: () => (stoppedYet ? { ref: 'lane/late' } : null),
    });
    expect(stopped).toEqual([readLedger(dir)[0].holdId]);
    expect(next.escalated).toEqual([{ holdId: readLedger(dir)[0].holdId, reason: 'conflict-override-used' }]);
    // while a reservation is launching, the clone is live for planning
    const c = clone(60);
    const launching = [{ cloneKey: KEY, holdId: 'x', status: 'cleared', launching: true, deadlineAt: NOW + MIN }];
    expect(planBundleRepairs({ clones: [c], ledger: launching, settings: on(), now: NOW }).held[0].rule).toBe(HOLD_RULES.ONE_PER_CLONE);
  });

  it('round 4: unreadable rebuild state is unknown, not cleared', async () => {
    const { dir, stopped, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    const s = await runBundleRepairs({ ...seams, selfSync: [{ cloneKey: KEY, rebuild: null }], now: NOW + MIN, ...settings() });
    expect(s.reconciled).toEqual([]);
    expect(stopped).toEqual([]);
    expect(readLedger(dir)[0].status).toBe('running');
  });

  it('round 4: the audit trail is re-read after the stop — an override made just before the stop is still caught', async () => {
    const { dir, published, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    repairedOutcome(dir);
    let stoppedYet = false;
    const s = await runBundleRepairs({
      ...seams, selfSync: [{ cloneKey: KEY, rebuild: { held: null } }], now: NOW + MIN, ...settings(),
      stop: () => { stoppedYet = true; },
      overrideFor: () => (stoppedYet ? { ref: 'lane/sneaky' } : null),
    });
    expect(s.escalated).toEqual([{ holdId: readLedger(dir)[0].holdId, reason: 'conflict-override-used' }]);
    expect(published.at(-1)).toMatchObject({ kind: 'bundle-repair' });
    expect(readLedger(dir)[0].status).toBe('escalated');
  });

  it('round 7: an outcome recorded while the session is being stopped is still escalated', async () => {
    const { dir, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    repairedOutcome(dir);
    const e = readLedger(dir)[0];
    const s = await runBundleRepairs({
      ...seams, now: NOW + MIN, ...settings(), selfSync: [{ cloneKey: KEY, rebuild: { held: null } }],
      stop: () => {
        mkdirSync(join(dir, 'bundle-repair', 'outcomes'), { recursive: true });
        writeFileSync(outcomePath(dir, e.holdId), JSON.stringify({ outcome: 'escalate', reason: 'weakened-twice', detail: 'late' }));
      },
    });
    expect(s.escalated).toEqual([{ holdId: e.holdId, reason: 'weakened-twice' }]);
    expect(readLedger(dir)[0].status).toBe('escalated');
  });

  it('round 7: an unreadable audit trail keeps the check pending until it can be read', async () => {
    const { dir, seams } = setup();
    await runBundleRepairs({ ...seams, ...settings() });
    repairedOutcome(dir);
    const gone = [{ cloneKey: KEY, rebuild: { held: null } }];
    await runBundleRepairs({ ...seams, now: NOW + MIN, ...settings(), selfSync: gone, overrideFor: () => { throw new Error('EACCES'); } });
    expect(readLedger(dir)[0]).toMatchObject({ status: 'cleared', auditCheckPending: true });
    const s = await runBundleRepairs({ ...seams, now: NOW + 2 * MIN, ...settings(), selfSync: gone, overrideFor: () => ({ ref: 'lane/x' }) });
    expect(s.escalated.map((x) => x.reason)).toEqual(['conflict-override-used']);
    expect(readLedger(dir)[0].auditCheckPending).toBeUndefined();
  });

  it('round 7: each escalation reason has its own feed identity (the feed de-duplicates by identity)', async () => {
    const { escalationItem } = await import('../bundle-repair-core.mjs');
    const { diffFeed } = await import('../../operations/needs-you-feed.mjs');
    const entry = { holdId: 'review-206df80e-x', name: 'review' };
    const a = escalationItem(entry, { reason: 'unresolvable-conflict', detail: 'd', host: 'h', weRoot: '/we' });
    const b = escalationItem(entry, { reason: 'conflict-override-used', detail: 'd', host: 'h', weRoot: '/we' });
    expect(a.head).not.toBe(b.head);
    const first = diffFeed([], [a], NOW, { incomplete: true });
    expect(diffFeed(first.openKeys, [b], NOW, { incomplete: true }).lines).toHaveLength(1);
  });

  it('record: only the session holding the capability, once', async () => {
    const { dir, seams } = setup();
    let token;
    await runBundleRepairs({ ...seams, dispatch: async (t, o) => { token = o.token; return { handle: 'h' }; }, ...settings() });
    const e = readLedger(dir)[0];
    const input = { outcome: 'repaired', top: 'lane/unfreeze-review-top-1021d', audits: [{ verdict: 'NOT WEAKENED' }], detail: 'ok' };
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token: 'wrong' })).toThrow(/capability/);
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: 'other', input, token })).toThrow(/belongs to/);
    recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token });
    expect(() => recordOutcome({ dir, holdId: e.holdId, session: e.session, input, token })).toThrow();
  });
});

describe('no operator credential', () => {
  it('the session spawns as the worker role and its settings env is resolved with the sink\'s worker options', () => {
    expect(workerSpawnEnv({ WE_GITHUB_APP_ROLE: 'operator', X: '1' })).toEqual({ WE_GITHUB_APP_ROLE: 'worker', X: '1' });
    const base = vi.fn((cwd, opts) => ({ ROLE: opts?.env?.WE_GITHUB_APP_ROLE ?? 'parent' }));
    const env = repairSettingsEnv(base, { stateRoot: '/s', token: 't', stateRootEnv: 'S' })('/cwd', { env: workerSpawnEnv({}) });
    expect(base).toHaveBeenCalledWith('/cwd', { env: { WE_GITHUB_APP_ROLE: 'worker' } });
    expect(env).toEqual({ ROLE: 'worker', S: '/s', WE_BUNDLE_REPAIR_TOKEN: 't' });
  });
});

describe('settings via the cascade', () => {
  it('retry settings leaves have standard defaults and inclusive integer bounds', () => {
    expect(BUNDLE_REPAIR_STANDARD).toMatchObject({ dispatchRetryBackoffMinutes: 60, maxDispatchRetries: 2 });
    for (const [leaf, valid, invalid] of [
      ['dispatchRetryBackoffMinutes', [1, 60, 1440], [0, 1441, 1.5, '60', null, NaN, Infinity]],
      ['maxDispatchRetries', [0, 2, 5], [-1, 6, 1.5, '2', null, NaN, Infinity]],
    ]) {
      expect(BUNDLE_REPAIR_VALID[leaf]).toBeTypeOf('function');
      for (const value of valid) expect(BUNDLE_REPAIR_VALID[leaf](value)).toBe(true);
      for (const value of invalid) expect(BUNDLE_REPAIR_VALID[leaf](value)).toBe(false);
    }
  });

  it('retry settings leaves appear in the cascade with effective values and logged sources', async () => {
    const log = vi.fn();
    const env = { WE_POLICY_CASCADE_LOG: '1' };
    const std = await resolveBundleRepairSettings({ env, platform: null, tool: {}, log });
    expect(std.settings).toMatchObject({ dispatchRetryBackoffMinutes: 60, maxDispatchRetries: 2 });
    expect(std.sources).toMatchObject({ dispatchRetryBackoffMinutes: 'standard', maxDispatchRetries: 'standard' });
    const platform = { dispatchRetryBackoffMinutes: 90, maxDispatchRetries: 3 };
    const plat = await resolveBundleRepairSettings({ env, platform, tool: {}, log });
    expect(plat.settings).toMatchObject(platform);
    expect(plat.sources).toMatchObject({ dispatchRetryBackoffMinutes: 'platform', maxDispatchRetries: 'platform' });
    const tool = await resolveBundleRepairSettings({ env, platform, tool: { dispatchRetryBackoffMinutes: 120, maxDispatchRetries: 0 }, log });
    expect(tool.settings).toMatchObject({ dispatchRetryBackoffMinutes: 120, maxDispatchRetries: 0 });
    expect(tool.sources).toMatchObject({ dispatchRetryBackoffMinutes: 'tool', maxDispatchRetries: 'tool' });
    for (const [value, source] of [[60, 'standard'], [90, 'platform'], [120, 'tool']]) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`dispatchRetryBackoffMinutes=${value} (${source})`));
    }
    for (const [value, source] of [[2, 'standard'], [3, 'platform'], [0, 'tool']]) {
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`maxDispatchRetries=${value} (${source})`));
    }
  });

  it.each([
    ['dispatchRetryBackoffMinutes', 0, 60], ['dispatchRetryBackoffMinutes', 1441, 60],
    ['dispatchRetryBackoffMinutes', 1.5, 60], ['dispatchRetryBackoffMinutes', '60', 60],
    ['maxDispatchRetries', -1, 2], ['maxDispatchRetries', 6, 2],
    ['maxDispatchRetries', 1.5, 2], ['maxDispatchRetries', '2', 2],
  ])('invalid retry setting %s=%s falls to standard and is reported', async (leaf, value, fallback) => {
    const r = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: null, tool: { [leaf]: value } });
    expect(r.settings[leaf]).toBe(fallback);
    expect(r.sources[leaf]).toBe('standard');
    expect(r.invalid.join()).toContain(leaf);
  });

  it('standard default is off + shadow; tool and env layers override with their source named; invalid ignored', async () => {
    const env = { WE_POLICY_CASCADE_LOG: '0' };
    const std = await resolveBundleRepairSettings({ env, tool: undefined, platform: null });
    expect(std.settings.mode).toBe('shadow');
    const log = vi.fn();
    const r = await resolveBundleRepairSettings({
      env: { WE_BUNDLE_REPAIR_ENABLED: '1', WE_POLICY_CASCADE_LOG: '1' }, platform: null, log,
      tool: { enabled: false, triggerMinutes: 45, maxConcurrent: 99, clones: ['review'] },
    });
    expect(r.settings).toMatchObject({ enabled: true, triggerMinutes: 45, maxConcurrent: 1, clones: ['review'], mode: 'shadow' });
    expect(r.sources).toMatchObject({ enabled: 'env', triggerMinutes: 'tool', maxConcurrent: 'standard', mode: 'standard' });
    expect(r.invalid.join()).toMatch(/maxConcurrent/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^policy-cascade · bundleRepair: .*enabled=true \(env\)/));
  });

  it('the committed tool file never sets enabled/mode — those defaults live in the standard layer only', () => {
    const file = JSON.parse(readFileSync(join(process.cwd(), 'scripts/settings/bundle-repair.json'), 'utf8'));
    expect(Object.hasOwn(file.bundleRepair, 'enabled')).toBe(false);
    expect(Object.hasOwn(file.bundleRepair, 'mode')).toBe(false);
    expect(BUNDLE_REPAIR_STANDARD).toMatchObject({ enabled: false, mode: 'shadow' });
  });

  const hostFile = (obj) => {
    const d = mkdtempSync(join(tmpdir(), 'br-plat-'));
    const p = join(d, 'platform-preferences.json');
    writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
  };

  it('platform enabled → enabled, sourced from the platform layer (the host platform-preferences file), over the real tool file', async () => {
    const path = hostFile({ heavyAdmission: { cap: 3 }, bundleRepair: { enabled: true, mode: 'shadow' } });
    const log = vi.fn();
    const r = await resolveBundleRepairSettings({ env: { WE_PLATFORM_PREFERENCES: path, WE_POLICY_CASCADE_LOG: '1' }, log });
    expect(r.settings).toMatchObject({ enabled: true, mode: 'shadow' });
    expect(r.sources).toMatchObject({ enabled: 'platform', mode: 'platform', triggerMinutes: 'tool' });
    expect(r.invalid).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^policy-cascade · bundleRepair: enabled=true \(platform\)/));
  });

  it('the env kill switch still wins over a platform enable', async () => {
    const path = hostFile({ bundleRepair: { enabled: true, mode: 'live' } });
    const r = await resolveBundleRepairSettings({ env: { WE_PLATFORM_PREFERENCES: path, WE_BUNDLE_REPAIR_ENABLED: '0', WE_POLICY_CASCADE_LOG: '0' } });
    expect(r.settings.enabled).toBe(false);
    expect(r.sources.enabled).toBe('env');
    expect(r.sources.mode).toBe('platform');
  });

  it('the host file: default path is the real user home; missing = not set; unreadable/invalid named, never enables', async () => {
    const reads = [];
    const out = readHostPlatformBundleRepair({ env: {}, home: '/h', underTest: false, readFile: (p) => { reads.push(p); return '{"bundleRepair":{"enabled":true}}'; } });
    expect(reads).toEqual(['/h/.claude/platform-preferences.json']);
    expect(out.block).toEqual({ enabled: true });
    expect(readHostPlatformBundleRepair({ env: {}, readFile: () => { throw new Error('must not read under test'); } })).toEqual({});
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    expect(readHostPlatformBundleRepair({ env: { WE_PLATFORM_PREFERENCES: '/x' }, readFile: () => { throw enoent; } }).block).toBeUndefined();
    const bad = await resolveBundleRepairSettings({ env: { WE_PLATFORM_PREFERENCES: hostFile('{torn'), WE_POLICY_CASCADE_LOG: '0' } });
    expect(bad.settings.enabled).toBe(false);
    expect(bad.sources.enabled).toBe('standard');
    expect(bad.invalid.join()).toMatch(/platform: /);
    const notObj = await resolveBundleRepairSettings({ env: { WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: true }), WE_POLICY_CASCADE_LOG: '0' } });
    expect(notObj.settings.enabled).toBe(false);
    expect(notObj.invalid.join()).toMatch(/not an object/);
    const badLeaf = await resolveBundleRepairSettings({ env: { WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: { enabled: 'yes' } }), WE_POLICY_CASCADE_LOG: '0' } });
    expect(badLeaf.settings.enabled).toBe(false);
    expect(badLeaf.invalid.join()).toMatch(/platform\.enabled/);
  });

  it('fails closed: an unreadable host file or any invalid leaf never leaves repairs on (a repo-platform or valid enable is overridden)', async () => {
    const repo = hostFile({ bundleRepair: { enabled: true, mode: 'live' } });
    const torn = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES_FILE: repo, WE_PLATFORM_PREFERENCES: hostFile('{torn') } });
    expect(torn.settings.enabled).toBe(false);
    expect(torn.sources.enabled).toBe('fail-closed');
    const mixed = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: { enabled: true, mode: 'live', maxConcurrent: 0 } }) } });
    expect(mixed.settings.enabled).toBe(false);
    expect(mixed.sources.enabled).toBe('fail-closed');
    for (const block of [{ enabled: true, mode: {} }, { enabled: true, maxConcurrent: {} }, { enabled: true, clones: {} }]) {
      const r = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: block }) } });
      expect(r.settings.enabled).toBe(false);
      expect(r.sources.enabled).toBe('fail-closed');
      expect(r.invalid.length).toBeGreaterThan(0);
    }
    const repoTorn = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES_FILE: hostFile('{torn'), WE_PLATFORM_PREFERENCES: repo } });
    expect(repoTorn.settings.enabled).toBe(false);
    expect(repoTorn.sources.enabled).toBe('fail-closed');
    expect(repoTorn.invalid.join()).toMatch(/platform \(repo\)/);
    const repoHidden = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0',
      WE_PLATFORM_PREFERENCES_FILE: hostFile({ bundleRepair: { enabled: true, mode: {} } }), WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: { enabled: true, mode: 'live' } }) } });
    expect(repoHidden.settings.enabled).toBe(false);
    expect(repoHidden.invalid.join()).toMatch(/platform \(repo\)\.mode/);
    const toolDir = (files) => {
      const d = mkdtempSync(join(tmpdir(), 'br-tool-'));
      for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), typeof c === 'string' ? c : JSON.stringify(c));
      return d;
    };
    const plat = { enabled: true, mode: 'live' };
    const tornTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat,
      toolFiles: { dir: toolDir({ 'bundle-repair.json': '{torn' }), legacyPath: null } });
    expect(tornTool.settings.enabled).toBe(false);
    expect(tornTool.invalid.join()).toMatch(/tool \(settings\/bundle-repair\.json\)/);
    const legacy = join(toolDir({}), 'dispatch-settings.json');
    writeFileSync(legacy, JSON.stringify({ bundleRepair: { mode: {} } }));
    const hiddenTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat,
      toolFiles: { dir: toolDir({ 'bundle-repair.json': { bundleRepair: { mode: 'live' } } }), legacyPath: legacy } });
    expect(hiddenTool.settings.enabled).toBe(false);
    expect(hiddenTool.invalid.join()).toMatch(/tool \(dispatch-settings\.json\)\.mode/);
    const noDir = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat,
      toolFiles: { dir: join(toolDir({}), 'missing'), legacyPath: null } });
    expect(noDir.settings.enabled).toBe(false);
    expect(noDir.invalid.join()).toMatch(/settings dir/);
    const danglingDir = toolDir({});
    symlinkSync(join(danglingDir, 'gone.json'), join(danglingDir, 'bundle-repair.json'));
    const dangling = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat, toolFiles: { dir: danglingDir, legacyPath: null } });
    expect(dangling.settings.enabled).toBe(false);
    expect(dangling.invalid.join()).toMatch(/tool \(settings\/bundle-repair\.json\)/);
    const danglingLegacy = join(toolDir({}), 'dispatch-settings.json');
    symlinkSync(join(danglingDir, 'gone-legacy.json'), danglingLegacy);
    const dl = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat, toolFiles: { dir: toolDir({}), legacyPath: danglingLegacy } });
    expect(dl.settings.enabled).toBe(false);
    expect(dl.invalid.join()).toMatch(/tool \(dispatch-settings\.json\)/);
    const noLegacy = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat, toolFiles: { dir: toolDir({}), legacyPath: join(toolDir({}), 'absent.json') } });
    expect(noLegacy.settings.enabled).toBe(true);
    const linkDir = toolDir({});
    const hostLink = join(linkDir, 'host.json'); symlinkSync(join(linkDir, 'gone-host.json'), hostLink);
    const repoLink = join(linkDir, 'repo.json'); symlinkSync(join(linkDir, 'gone-repo.json'), repoLink);
    const enabler = hostFile({ bundleRepair: { enabled: true } });
    const hostDangling = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES_FILE: enabler, WE_PLATFORM_PREFERENCES: hostLink } });
    expect(hostDangling.settings.enabled).toBe(false);
    expect(hostDangling.invalid.join()).toMatch(/platform: /);
    const repoDangling = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0', WE_PLATFORM_PREFERENCES_FILE: repoLink, WE_PLATFORM_PREFERENCES: enabler } });
    expect(repoDangling.settings.enabled).toBe(false);
    expect(repoDangling.invalid.join()).toMatch(/platform \(repo repo\.json\)/);
    const nullTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat,
      toolFiles: { dir: toolDir({ 'bundle-repair.json': { bundleRepair: null } }), legacyPath: null } });
    expect(nullTool.settings.enabled).toBe(false);
    const nullRepo = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0',
      WE_PLATFORM_PREFERENCES_FILE: hostFile({ bundleRepair: null }), WE_PLATFORM_PREFERENCES: hostFile({ bundleRepair: { enabled: true } }) } });
    expect(nullRepo.settings.enabled).toBe(false);
    expect(nullRepo.sources.enabled).toBe('fail-closed');
    const cleanTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: plat,
      toolFiles: { dir: toolDir({ 'bundle-repair.json': { bundleRepair: { triggerMinutes: 20 } } }), legacyPath: null } });
    expect(cleanTool.settings).toMatchObject({ enabled: true, mode: 'live', triggerMinutes: 20 });
    expect(cleanTool.invalid).toEqual([]);
    const objTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: { enabled: true }, tool: { mode: {} } });
    expect(objTool.settings.enabled).toBe(false);
    const badTool = await resolveBundleRepairSettings({ env: { WE_POLICY_CASCADE_LOG: '0' }, platform: { enabled: true }, tool: { wallTimeMinutes: 1 } });
    expect(badTool.settings.enabled).toBe(false);
  });
});

describe('bundle-repair dispatch carries a resolvable model', () => {
  it('builds an argv with exactly one non-flag --model for the bundle-repair kind, with no routing table', async () => {
    const argv = buildAgentArgv({ sessionId: 'sid-1', payload: { launchKind: 'bundle-repair', sessionSlug: 'bundle-repair-x', prompt: 'repair' }, extraArgs: [] });
    const at = argv.indexOf('--model');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv.filter((a) => a === '--model')).toHaveLength(1);
    expect(String(argv[at + 1]).trim()).not.toBe('');
    expect(String(argv[at + 1]).startsWith('-')).toBe(false);
    expect(argv[at + 1]).not.toMatch(/fable/i);
  });
});
