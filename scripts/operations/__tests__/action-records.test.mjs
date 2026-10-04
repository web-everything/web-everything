/** #3383 — Crash, lag, expiry and concurrent drivers must never authorize a second effect. */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createActionStore, CoordinationUnavailableError } from '../action-store.mjs';
import { actionResource, isExpired } from '../action-record.mjs';
import { guardedDispatch, reconcileActions } from '../action-dispatch.mjs';
const resource = actionResource('we', { type: 'pr', id: 2345 });
let clock, actions;
const now = () => clock;
const claim = (owner = 'a', extra = {}) => actions.claim({ resource, kind: 'fix', owner, ...extra });
const transition = (r, to, patch = {}) => actions.transition(resource, r.attempt, { token: r.ownerToken, rev: r.rev, from: r.state, to, patch });
const absent = { listAgents: () => [], findEffect: () => ({ found: false }) };
beforeEach(() => { clock = 1_000; actions = createActionStore({ now, leaseMs: 10, absenceGraceMs: 100 }); });
describe('resource actions', () => {
  it('normalizes keys and qualified slugs and refuses unknown repos', () => {
    expect(actionResource('frontierui', { type: 'item', id: 'x4e6oux' })).toBe('frontier-ui/frontierui#item:x4e6oux');
    expect(actionResource('web-everything', { type: 'pr', id: '02345' })).toBe(resource);
    expect(actionResource('we', { type: 'item', id: '# XABC' })).toBe('web-everything/web-everything#item:xabc');
    expect(() => actionResource('unknown', { type: 'pr', id: 1 })).toThrow(/Unknown/);
  });
  it('allows only the lifecycle and valid terminal outcomes', async () => {
    let r = claim().record;
    expect(transition(r, 'observed', { handle: 'x' }).reason).toBe('illegal-transition');
    r = transition(r, 'dispatching', { dispatchingSince: now() }).record;
    expect(transition(r, 'terminal', { outcome: 'settled' }).ok).toBe(false);
    r = transition(r, 'observed', { handle: 'agent' }).record;
    expect(transition(r, 'dispatching').ok).toBe(false);
    r = (await actions.settle(resource, 1, { postconditionHolds: () => true })).record;
    expect(r).toMatchObject({ state: 'terminal', outcome: 'settled', rev: 4 });
    expect(transition(r, 'intent').ok).toBe(false);
    expect(r.history.map((x) => x.state)).toEqual(['intent', 'dispatching', 'observed', 'terminal']);
  });
  it('allocates exactly one of concurrent claims per attempt with contiguous numbers', async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => claim(`driver-${i}`))));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      expect(winners[0].record.attempt).toBe(attempt);
      expect(actions.release(resource, attempt, { token: winners[0].record.ownerToken }).ok).toBe(true);
    }
    expect(actions.attempts(resource).map((r) => r.attempt)).toEqual([1, 2, 3, 4]);
    expect(() => claim('b', { attempt: 30 })).toThrow(/allocated/);
  });
  it('fences wrong tokens and stale revisions on update, heartbeat, and release', () => {
    const r = claim().record;
    expect(actions.heartbeat(resource, 1, 'wrong').ok).toBe(false);
    expect(actions.release(resource, 1, { token: 'wrong' }).ok).toBe(false);
    expect(actions.transition(resource, 1, { token: 'wrong', from: 'intent', to: 'dispatching' }).ok).toBe(false);
    expect(actions.heartbeat(resource, 1, r.ownerToken).ok).toBe(true);
    expect(transition(r, 'dispatching').reason).toBe('stale-rev');
    expect(actions.read(resource, 1).state).toBe('intent');
  });
  it('holds a crash between recording dispatching and executing the effect until both probes prove absence after grace', async () => {
    const r = transition(claim().record, 'dispatching', { dispatchingSince: now() }).record;
    clock += 11;
    const reconcile = (record) => actions.reconcile(record, absent);
    expect(await claim('b', { reconcile })).toMatchObject({ ok: false, reason: 'held:indeterminate' });
    clock += 101;
    expect(await actions.reconcile(r, { ...absent, listAgents: () => { throw new Error('offline'); } })).toMatchObject({ reason: 'held:indeterminate' });
    expect((await claim('b', { reconcile })).record.attempt).toBe(2);
    expect(actions.read(resource, 1).outcome).toBe('abandoned-absent');
  });
  it('adopts a slow effect after lease expiry and refuses the original driver’s late writes', async () => {
    let finish, heartbeat, spawned = 0;
    const pending = guardedDispatch({ resource, kind: 'fix', owner: 'a', actions, now,
      effect: (ctx) => { spawned++; heartbeat = ctx.heartbeat; return new Promise((r) => { finish = r; }); } });
    const old = actions.read(resource, 1);
    clock += 11;
    const second = await guardedDispatch({ resource, kind: 'review', owner: 'b', actions, now,
      reconcile: (r) => actions.reconcile(r, { listAgents: () => [{ resource, sessionId: 'agent' }], findEffect: () => ({ found: false }), owner: 'b' }),
      effect: () => { spawned++; return 'other'; } });
    expect(second).toMatchObject({ dispatched: false, held: true });
    expect(actions.read(resource, 1)).toMatchObject({ state: 'observed', handle: 'agent', owner: 'b' });
    expect(heartbeat()).toBe(false);
    finish('agent');
    expect(await pending).toMatchObject({ dispatched: true, ownershipLost: true });
    expect(transition(old, 'observed', { handle: 'old' }).reason).toBe('owner-lost');
    expect(spawned).toBe(1);
  });
  it('re-reads before claim even when another driver previously saw an empty resource', () => {
    const b = createActionStore({ now });
    expect(b.attempts(resource)).toEqual([]);
    claim();
    expect(b.claim({ resource, kind: 'review', owner: 'b' }).ok).toBe(false);
  });
  it('loses create-exclusive after another driver claims between its scan and open', () => {
    let raced = false;
    const b = createActionStore({ now, fs: { ...fs, openSync: (path, flags) => {
      if (!raced && flags === 'wx') { raced = true; expect(claim().ok).toBe(true); }
      return fs.openSync(path, flags);
    } } });
    let effects = 0;
    const result = guardedDispatch({ resource, kind: 'review', owner: 'b', actions: b, now,
      effect: () => { effects++; return 'bad'; } });
    expect(result).toMatchObject({ dispatched: false, held: true });
    expect(effects).toBe(0);
    expect(actions.attempts(resource)).toHaveLength(1);
  });
  it.each([undefined, null, {}, { found: 'no' }])('preserves dispatching when effect evidence is unusable (%j)', async (effect) => {
    const r = transition(claim().record, 'dispatching', { dispatchingSince: now() }).record;
    clock += 1_000;
    expect(await actions.reconcile(r, { listAgents: () => [], findEffect: () => effect })).toMatchObject({ reason: 'held:indeterminate' });
    expect(actions.read(resource, 1)).toEqual(r);
  });
  it('fails closed on corrupt records, list errors, and unreadable resource directories', () => {
    claim();
    fs.writeFileSync(actions.pathFor(resource, 1), '{');
    expect(() => actions.list()).toThrow(CoordinationUnavailableError);
    let calls = 0;
    const run = (store) => guardedDispatch({ resource, kind: 'review', owner: 'b', actions: store, now, effect: () => { calls++; return 'bad'; } });
    expect(run(actions)).toMatchObject({ dispatched: false, reason: 'unavailable' });
    const injectedFs = { ...fs, readdirSync: () => { throw new Error('EACCES'); } };
    const unavailable = createActionStore({ fs: injectedFs });
    expect(() => unavailable.list()).toThrow(CoordinationUnavailableError);
    expect(run(unavailable).reason).toBe('unavailable');
    const denied = createActionStore({ fs: { ...fs, readdirSync: (path) => {
      if (String(path).includes(encodeURIComponent(resource))) throw new Error('EACCES');
      return fs.readdirSync(path);
    } } });
    expect(() => denied.attempts(resource)).toThrow(CoordinationUnavailableError);
    expect(run(denied).held).toBe(true);
    expect(calls).toBe(0);
  });
  it('keeps completed effects observed until their postcondition, and only warns on age', async () => {
    actions = createActionStore({ now, maxObservedAgeMs: 5 });
    await guardedDispatch({ resource, kind: 'fix', owner: 'a', actions, now, effect: () => 'agent' });
    clock += 100;
    expect(await actions.settle(resource, 1, { postconditionHolds: () => false })).toMatchObject({ reason: 'stuck-observed' });
    expect(claim('b').ok).toBe(false);
    const results = await reconcileActions({ actions, ...absent, postconditionHolds: () => true, now });
    expect(results[0].record.outcome).toBe('settled');
    expect(claim('b').ok).toBe(true);
  });
  it('never expires on a backwards clock and can abandon an expired intent', async () => {
    const r = claim().record;
    clock -= 100;
    expect(isExpired(r, now())).toBe(false);
    clock += 111;
    expect((await actions.reconcile(r)).record.outcome).toBe('abandoned-absent');
  });
  it('ends proved pre-spawn refusal and permits another attempt, but retains unknown throws', () => {
    expect(() => guardedDispatch({ resource, kind: 'fix', owner: 'a', actions, now,
      effect: () => { throw Object.assign(new Error('refused'), { notApplied: true }); } })).toThrow('refused');
    expect(actions.read(resource, 1).outcome).toBe('not-started');
    expect(() => guardedDispatch({ resource, kind: 'fix', owner: 'b', actions, now,
      effect: () => { throw new Error('unknown'); } })).toThrow('unknown');
    expect(actions.read(resource, 2).state).toBe('dispatching');
    expect(claim('c').ok).toBe(false);
  });
});
it('never reports a post-spawn store error as a non-dispatch', () => {
  const transition = actions.transition;
  const broken = { ...actions, transition: (...args) => {
    if (args[2].to === 'observed') throw new CoordinationUnavailableError('/tmp/actions', new Error('write failed'));
    return transition(...args);
  } };
  let called = 0;
  expect(() => guardedDispatch({ resource, kind: 'fix', owner: 'a', actions: broken, now,
    effect: () => { called++; return 'agent'; } })).toThrow(CoordinationUnavailableError);
  expect(called).toBe(1);
  expect(actions.read(resource, 1).state).toBe('dispatching');
});
