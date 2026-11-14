/**
 * @file wake.test.mjs — the waker, and the observer half of the sink registry (#x0t9923, ruled by #3070).
 *
 * THE LOAD-BEARING TESTS are the fail-soft ones and the ordering one. A pass touches every parked run in the
 * store, so the interesting cases are not "an observer said applied" — they are "one run is broken and the
 * others still wake", and "the answer is persisted before anything that could crash".
 *
 * Nothing here spawns a process or touches disk: observers are stubs, the store is in memory, and the clock
 * is injected.
 */

import { describe, it, expect, vi } from 'vitest';

import { createWakeObservers } from '../wake.mjs';
import { createDispatchObservers } from '../dispatch-lane-io.mjs';
import { createExploreObservers } from '../explore-io.mjs';

import { advanceWhileRunning, runStatus, startRun } from '../engine.mjs';
import { applyPendingEffects, inFlight, inFlightEntries, notApplied } from '../effect-executor.mjs';
import { createEffectObserver, observeRun, planObservations, OBSERVATIONS, SKIPS } from '../effect-observer.mjs';
import { hoursStuck, isParkedOnDispatch, isParkedUnsettled, renderPass, stuckPast, wakePass, wakeRun, STUCK_ESCALATION_HOURS } from '../wake.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry, op } from '../registry.mjs';
import { confirm as confirmStep, effect, judge as judgeStep } from '../step-kinds.mjs';

const OP = 'fx-wake';
const KEY = 'run-w#0#0';
const NOTE = 'run-w#0#1';

/** One dispatch, then an ordinary effect after it — so "the run finishes what it was doing" is observable. */
function registryFor() {
  const r = createRegistry();
  r.register(op(OP, {
    input: { pr: { type: 'number', required: true } },
    go: effect({
      reads: ['input.pr'],
      effects: () => [
        { type: 'start.build', payload: {}, dispatch: true },
        { type: 'note.write', payload: {} },
      ],
    }),
  }));
  return r;
}

const registry = registryFor();
const SINKS = {
  'start.build': async () => inFlight({ handle: 'sess-abc', expectedBy: '2099-01-01T00:00:00.000Z' }),
  'note.write': async () => ({ ok: true }),
};

/** Drive a fresh run to its park. Returns the parked record and the store holding it. */
async function parked(id = 'run-w', sinks = SINKS) {
  const store = createMemoryRunStore();
  let run = advanceWhileRunning(startRun({ op: OP, id, input: { pr: 7 }, registry }), { registry });
  store.write(run);
  run = (await applyPendingEffects(run, { sinks, store })).run;
  expect(run.effects[0].status).toBe('in-flight');
  return { run, store };
}

const resolveFor = () => ({ registry, sinks: SINKS });

describe('planObservations — what a pass would do, before doing any of it', () => {
  it('observes an entry that is running and inside its deadline', async () => {
    const { run } = await parked();
    const plan = planObservations(run, { 'start.build': async () => ({ status: 'running' }) }, '2026-01-01T00:00:00.000Z');
    expect(plan.observe.map((e) => e.key)).toEqual([KEY]);
    expect(plan.skip).toEqual([]);
  });

  // OVERDUE IS STILL OBSERVED. Past its own estimate changes what a human is told, not what the machine asks —
  // an `expectedBy` is an estimate, and failing an entry on a clock alone would kill slow-but-healthy work.
  it('observes an OVERDUE entry too, rather than declaring it dead', async () => {
    const { run } = await parked();
    const plan = planObservations(run, { 'start.build': async () => ({ status: 'running' }) }, '2100-01-01T00:00:00.000Z');
    expect(inFlightEntries(run, '2100-01-01T00:00:00.000Z').overdue).toHaveLength(1);
    expect(plan.observe.map((e) => e.key)).toEqual([KEY]);
  });

  it('SKIPS a handle-less entry — there is nothing to poll, and guessing is the thing being avoided', async () => {
    const { run } = await parked('run-w', {
      'start.build': async () => { throw new Error('lost the child before it reported back'); },
      'note.write': SINKS['note.write'],
    });
    const plan = planObservations(run, { 'start.build': async () => ({ status: 'succeeded' }) });
    expect(plan.observe).toEqual([]);
    expect(plan.skip).toEqual([{ key: KEY, type: 'start.build', reason: SKIPS.NO_HANDLE }]);
  });

  it('SKIPS a type with no registered observer, and says which', async () => {
    const { run } = await parked();
    const plan = planObservations(run, {});
    expect(plan.observe).toEqual([]);
    expect(plan.skip).toEqual([{ key: KEY, type: 'start.build', reason: SKIPS.NO_OBSERVER }]);
  });
});

describe('observeRun — folding terminal answers into the record', () => {
  it('a `running` answer changes nothing', async () => {
    const { run } = await parked();
    const out = await observeRun(run, { observers: { 'start.build': async () => ({ status: 'running' }) } });
    expect(out.stillRunning).toEqual([KEY]);
    expect(out.resolved).toEqual([]);
    expect(out.run.effects[0].status).toBe('in-flight');
  });

  it('`succeeded` records `applied` — the work ran and finished cleanly, so the run may advance', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded', result: { exit: 0 } }) },
    });
    expect(out.run.effects[0]).toMatchObject({ status: 'applied', result: { exit: 0 } });
    expect(out.resolved[0]).toMatchObject({ status: 'succeeded', recordedAs: 'applied' });
  });

  // #3085: `resolved` hands a KNOWN outcome onward instead of judging it — unlike `succeeded`, an `error`
  // alongside it is not a contradiction, and `result` may itself describe a failure.
  it('`resolved` records `applied` with a failing `result`, unlike `succeeded` which refuses one', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'resolved', result: { exit: 1, log: 'BUILD FAILED' } }) },
    });
    expect(out.run.effects[0]).toMatchObject({ status: 'applied', result: { exit: 1, log: 'BUILD FAILED' } });
    expect(out.resolved[0]).toMatchObject({ status: 'resolved', recordedAs: 'applied' });
  });

  it('`resolved` permits an `error` alongside the result — it makes no clean-outcome claim', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'resolved', result: { exit: 1 }, error: 'BUILD FAILED' }) },
    });
    expect(out.errors).toEqual([]);
    expect(out.run.effects[0]).toMatchObject({ status: 'applied', result: { exit: 1 }, error: 'BUILD FAILED' });
  });

  // THE PROBE FROM #3085 ITSELF: a declaration with a reacting step sees a dispatched build's failing outcome,
  // and nothing re-dispatches it — `resolved` records `applied`, same as `succeeded`.
  it('a declaration with a reacting step sees the outcome the waker resolved, and nothing re-dispatches', async () => {
    const r = createRegistry();
    r.register(op('fx-react', {
      input: { pr: { type: 'number', required: true } },
      go: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      react: confirmStep({
        reads: ['findings.go'],
        asks: (v) => `The build ${v.findings.go.effects[0].result.exit === 0 ? 'passed' : 'FAILED'}. Land anyway?`,
        of: () => 'human',
      }),
    }));
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-react', id: 'run-react', input: { pr: 7 }, registry: r }), { registry: r });
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'resolved', result: { exit: 1, log: 'BUILD FAILED' } }) },
      resolveFor: () => ({ registry: r, sinks: SINKS }),
    });
    expect(pass.runs[0].resolved).toEqual([{ key: 'run-react#0#0', type: 'start.build', status: 'resolved', recordedAs: 'applied' }]);
    const rec = store.read('run-react');
    expect(rec.findings.go.effects[0].result).toEqual({ exit: 1, log: 'BUILD FAILED' });
    expect(rec.pending).toMatchObject({ kind: 'confirm', asks: 'The build FAILED. Land anyway?' });
  });

  // THE ONE THAT TOOK THREE ROUNDS. Anything that is over but not a clean success WRITES NOTHING — there is
  // no status meaning "this is done and nobody should touch it", so writing one always licensed the next
  // caller to retry or to advance. The entry stays in-flight and a person decides.
  it('`unresolved` writes NOTHING and is reported for a person', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'the build died' }) },
    });
    expect(out.run.effects[0].status).toBe('in-flight');
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([{ key: KEY, type: 'start.build', error: 'the build died' }]);
  });

  // Both earlier vocabularies are gone, so neither can be answered by accident.
  it('REFUSES the words that collided — `failed` and `never-started`', async () => {
    const { run } = await parked();
    for (const bad of ['failed', 'never-started', 'finished']) {
      const out = await observeRun(run, { observers: { 'start.build': async () => ({ status: bad }) } });
      expect(out.run.effects[0].status).toBe('in-flight');
      expect(out.errors[0].error).toMatch(/expected one of/);
    }
  });

  // FAIL-SOFT. The entry is still in-flight, which is the truth, and the next pass asks again.
  it('an observer that THROWS is reported and leaves its entry alone', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => { throw new Error('poll timed out'); } },
    });
    expect(out.errors[0]).toMatchObject({ key: KEY });
    expect(out.errors[0].error).toMatch(/poll timed out/);
    expect(out.run.effects[0].status).toBe('in-flight');
  });

  it('an observer answering outside the closed set is reported, not obeyed', async () => {
    const { run } = await parked();
    for (const bad of ['done', 'succeeded ', 'failed', 'never-started', null, undefined, 42]) {
      const out = await observeRun(run, { observers: { 'start.build': async () => ({ status: bad }) } });
      expect(out.run.effects[0].status).toBe('in-flight');
      expect(out.errors[0].error).toMatch(/expected one of/);
    }
    expect(OBSERVATIONS).toEqual(['running', 'succeeded', 'resolved', 'unresolved']);
  });

  it('createEffectObserver validates its wiring at construction, not at the first pass', () => {
    expect(() => createEffectObserver({ observers: 'nope' })).toThrow(/must be an object or a Map/);
    expect(createEffectObserver({ observers: { b: () => {}, a: () => {} } }).types()).toEqual(['a', 'b']);
  });
});

describe('wakeRun — one pass over one run', () => {
  it('resolving the dispatch lets the run finish the rest of the step and complete', async () => {
    const { run, store } = await parked();
    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded', result: { exit: 0 } }) },
      store, registry, sinks: SINKS,
    });
    expect(report.resolved).toHaveLength(1);
    expect(report.advanced).toBe(true);
    expect(report.status).toBe('complete');
    expect(store.read('run-w').effects.map((e) => e.status)).toEqual(['applied', 'applied']);
  });

  it('leaves a still-running run exactly where it was, and spends no advance on it', async () => {
    const { run, store } = await parked();
    const writes = [];
    const spy = { read: store.read, write: (r) => { writes.push(r.id); return store.write(r); }, list: store.list };
    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'running' }) },
      store: spy, registry, sinks: SINKS,
    });
    expect(report.stillRunning).toEqual([KEY]);
    expect(report.advanced).toBe(false);
    expect(report.status).toBe('awaiting-effect');
    expect(writes).toEqual([]);
  });

  // THE ORDERING. An observation is the only record that the work finished — the observer may not be able to
  // answer twice — so it is persisted BEFORE anything that could crash.
  it('persists the resolution BEFORE advancing, so a crash in advance loses no answer', async () => {
    const { run, store } = await parked();
    const seen = [];
    const spy = {
      read: store.read,
      write: (r) => { seen.push(r.effects.map((e) => e.status).join(',')); return store.write(r); },
      list: store.list,
    };
    await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store: spy,
      registry,
      // A sink that throws mid-advance: the resolution must already be on disk by then.
      sinks: { ...SINKS, 'note.write': async () => { throw new Error('boom'); } },
    });
    expect(seen[0]).toBe('applied,declared');
    expect(store.read('run-w').effects[0].status).toBe('applied');
  });

  it('a sink failing during the advance is reported, not thrown', async () => {
    const { run, store } = await parked();
    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store,
      registry,
      sinks: { ...SINKS, 'note.write': async () => { throw new Error('boom'); } },
    });
    expect(report.errors.map((e) => e.error).join(' ')).toMatch(/boom/);
  });

  // A dispatch that starts another dispatch is legitimate — the pass stops and the next one picks it up.
  it('re-parks rather than looping when advancing reaches a NEW dispatch', async () => {
    const r = createRegistry();
    r.register(op('fx-chain', {
      input: { pr: { type: 'number', required: true } },
      one: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      two: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
    }));
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-chain', id: 'run-x', input: { pr: 7 }, registry: r }), { registry: r });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;

    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store, registry: r, sinks: SINKS,
    });
    expect(report.status).toBe('awaiting-effect');
    expect(inFlightEntries(store.read('run-x')).running).toHaveLength(1);
  });
});

describe('wakePass — one pass over the whole store', () => {
  it('ignores runs that are not parked on a dispatch', async () => {
    const { store } = await parked();
    const fresh = startRun({ op: OP, id: 'run-fresh', input: { pr: 7 }, registry });
    store.write(fresh);
    expect(isParkedOnDispatch(fresh)).toBe(false);

    const pass = await wakePass({
      store, observers: { 'start.build': async () => ({ status: 'running' }) }, resolveFor,
    });
    expect(pass.scanned).toBe(2);
    expect(pass.parked).toBe(1);
    expect(pass.runs.map((r) => r.runId)).toEqual(['run-w']);
  });

  // THE ONE THAT MATTERS FOR A TIMER JOB. One odd run must not stop the rest — a waker that dies on the first
  // unreadable record stops waking everything.
  it('one broken run does not stop the others', async () => {
    const a = await parked('run-a');
    const b = await parked('run-b');
    for (const id of b.store.list()) a.store.write(b.store.read(id));
    const store = {
      list: () => ['run-a', 'run-bad', 'run-b'],
      read: (id) => { if (id === 'run-bad') throw new Error('unreadable record'); return a.store.read(id); },
      write: a.store.write,
    };

    const pass = await wakePass({
      store, observers: { 'start.build': async () => ({ status: 'succeeded' }) }, resolveFor,
    });
    expect(pass.errors).toEqual([{ runId: 'run-bad', error: 'unreadable record' }]);
    expect(pass.runs.map((r) => r.runId).sort()).toEqual(['run-a', 'run-b']);
    expect(pass.runs.every((r) => r.resolved.length === 1)).toBe(true);
  });

  it('an unresolvable operation is reported against its run, and the pass continues', async () => {
    const { store } = await parked();
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      resolveFor: () => { throw new Error('no operation named "fx-wake"'); },
    });
    expect(pass.parked).toBe(1);
    expect(pass.errors[0]).toMatchObject({ runId: 'run-w' });
    expect(pass.runs).toEqual([]);
  });

  it('is quiet when nothing is parked — this runs on a timer', async () => {
    const store = createMemoryRunStore();
    store.write(startRun({ op: OP, id: 'run-idle', input: { pr: 7 }, registry }));
    const pass = await wakePass({ store, observers: {}, resolveFor });
    expect(renderPass(pass)).toEqual(['wake: 1 run(s) scanned, none parked on a dispatch.']);
  });

  it('names what it skipped, so an unwatched dispatch is visible rather than silently ignored', async () => {
    const { store } = await parked();
    const pass = await wakePass({ store, observers: {}, resolveFor });
    expect(renderPass(pass).join('\n')).toMatch(/SKIPPED run-w#0#0 \(no-observer\)/);
  });
});

/**
 * NOTHING IS EVER RE-DISPATCHED, BY ANY CALLER, ON ANY TICK (PR #1186 rounds 1-3). Three vocabularies were
 * measured re-running real work: an observer's `failed` on the waker's timer; then, after the waker halted,
 * on the operator's `--resume`; then `never-started` on every tick, eleven builds over ten ticks at exit 0.
 * The fix is that `unresolved` writes NO status, so there is nothing for the next caller to act on.
 */
describe('nothing is re-dispatched, by the waker or by a resume, however many ticks run', () => {
  function countingSinks(calls) {
    return {
      'start.build': async () => { calls.push('dispatch'); return inFlight({ handle: 'sess-abc' }); },
      'note.write': async () => ({ ok: true }),
    };
  }

  async function parkedCounting(calls, id = 'run-w') {
    const sinks = countingSinks(calls);
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: OP, id, input: { pr: 7 }, registry }), { registry });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks, store })).run;
    return { run, store, sinks };
  }

  // Round 3's blocking finding, as a test: ten ticks of a persistently broken dispatch.
  it('a persistently unresolved dispatch stays at ONE dispatch across ten ticks', async () => {
    const calls = [];
    const { store, sinks } = await parkedCounting(calls);
    expect(calls).toEqual(['dispatch']);
    const observers = { 'start.build': async () => ({ status: 'unresolved', error: 'bad credentials' }) };
    for (let i = 0; i < 10; i += 1) {
      const pass = await wakePass({ store, observers, resolveFor: () => ({ registry, sinks }) });
      expect(pass.runs[0].unresolved).toHaveLength(1);
      expect(pass.runs[0].advanced).toBe(false);
    }
    expect(calls).toEqual(['dispatch']);
  });

  // Round 2's blocking finding, as a test: the operator's own recovery path.
  it('nor by the operator resuming, which is the recovery the run itself prints', async () => {
    const calls = [];
    const { store, sinks } = await parkedCounting(calls);
    await wakeRun(store.read('run-w'), {
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'the build died' }) },
      store, registry, sinks,
    });
    // Exactly what `--resume` does: re-enter the executor on the same record. The entry is still in-flight
    // and observable, so the executor reports the park and calls no sink.
    const out = await applyPendingEffects(store.read('run-w'), { sinks, store });
    expect(out.inFlight).toEqual([KEY]);
    expect(calls).toEqual(['dispatch']);
  });

  it('SAYS a person is needed, rather than looking identical to still-running', async () => {
    const calls = [];
    const { store, sinks } = await parkedCounting(calls);
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'tests red' }) },
      resolveFor: () => ({ registry, sinks }),
    });
    expect(renderPass(pass).join('\n')).toMatch(/NEEDS A PERSON — terminal but not actionable/);
    expect(renderPass(pass).join('\n')).toMatch(/tests red/);
  });

  // A clean success still advances — the stop is scoped to what the model cannot express, not to everything.
  it('a SUCCEEDED dispatch still advances the run to completion', async () => {
    const calls = [];
    const { run, store, sinks } = await parkedCounting(calls);
    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded', result: { exit: 0 } }) },
      store, registry, sinks,
    });
    expect(report.advanced).toBe(true);
    expect(report.status).toBe('complete');
    expect(calls).toEqual(['dispatch']);
  });
});

/**
 * THE SAFETY PROPERTY THAT MATTERS MOST, and it was defended by a comment only (PR #1186 review, NB-1).
 * #3070 ruled the waker calls `advance` and nothing else. A confirm owed to a HUMAN must therefore survive a
 * pass untouched — the reviewer mutated the else-branch to auto-answer one and the whole suite stayed green,
 * because no `confirm` step appeared anywhere in this file.
 */
describe('the waker hands back every suspend that is not an effect', () => {
  /** A dispatch, then a confirm addressed to a human. */
  function humanRegistry() {
    const r = createRegistry();
    r.register(op('fx-human', {
      input: { pr: { type: 'number', required: true } },
      go: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      ok: confirmStep({ reads: ['input.pr'], asks: () => 'Land it?', of: () => 'human', options: ['accept', 'changes'] }),
    }));
    return r;
  }

  it('leaves a HUMAN-addressed confirm suspended, and answers nothing', async () => {
    const r = humanRegistry();
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-human', id: 'run-h', input: { pr: 7 }, registry: r }), { registry: r });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;

    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store, registry: r, sinks: SINKS,
    });
    expect(report.status).toBe('awaiting-confirm');
    const after = store.read('run-h');
    expect(after.pending).toMatchObject({ kind: 'confirm', of: 'human' });
    expect(after.findings.ok).toBeUndefined(); // nothing answered it
  });

  // NB2-1: the first fix pinned ONE shape, so two other auto-answers still slipped past the whole suite —
  // an AGENT-addressed confirm, and a judge step, which is the worse of the two because answering it invents
  // a verdict without ever spawning a juror.
  it('leaves an AGENT-addressed confirm suspended too — the waker answers no confirm at all', async () => {
    const r = createRegistry();
    r.register(op('fx-agent', {
      input: { pr: { type: 'number', required: true } },
      go: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      ok: confirmStep({ reads: ['input.pr'], asks: () => 'Land it?', of: () => 'agent', options: ['accept', 'changes'] }),
    }));
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-agent', id: 'run-a', input: { pr: 7 }, registry: r }), { registry: r });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;

    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store, registry: r, sinks: SINKS,
    });
    expect(report.status).toBe('awaiting-confirm');
    expect(store.read('run-a').findings.ok).toBeUndefined();
  });

  it('leaves a JUDGE step suspended — answering it would invent a verdict with no juror', async () => {
    const r = createRegistry();
    r.register(op('fx-judge', {
      input: { pr: { type: 'number', required: true } },
      go: effect({ reads: ['input.pr'], effects: () => [{ type: 'start.build', payload: {}, dispatch: true }] }),
      look: judgeStep({
        reads: ['input.pr'],
        request: () => ({
          mandate: 'judge it',
          input: 'x',
          shape: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
        }),
      }),
    }));
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-judge', id: 'run-j', input: { pr: 7 }, registry: r }), { registry: r });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;

    const report = await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store, registry: r, sinks: SINKS,
    });
    expect(report.status).toBe('awaiting-judge');
    expect(store.read('run-j').findings.look).toBeUndefined();
  });

  // The no-progress break: without it the loop burns all 64 turns and writes the record on each one.
  it('stops as soon as advancing makes no progress, rather than spending the whole turn cap', async () => {
    const r = humanRegistry();
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: 'fx-human', id: 'run-h', input: { pr: 7 }, registry: r }), { registry: r });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: SINKS, store })).run;

    let writes = 0;
    const spy = { read: store.read, write: (x) => { writes += 1; return store.write(x); }, list: store.list };
    await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store: spy, registry: r, sinks: SINKS,
    });
    // The resolution, then the one advance that reaches the confirm. Not 64.
    expect(writes).toBeLessThanOrEqual(3);
  });
});

describe('wakePass is fail-soft at its own front door', () => {
  it('a store whose list() throws is reported, not thrown', async () => {
    const store = { list: () => { throw new Error('store offline'); }, read: () => null, write: () => {} };
    const pass = await wakePass({ store, observers: {}, resolveFor });
    expect(pass.errors).toEqual([{ error: 'store offline' }]);
    expect(pass.scanned).toBe(0);
    expect(pass.runs).toEqual([]);
  });
});

describe('wakePass survives a store that answers oddly', () => {
  it('a list() that RETURNS a non-array is reported, not thrown (NB2-2)', async () => {
    for (const bad of [null, undefined, 'run-a', 42, {}]) {
      const store = { list: () => bad, read: () => null, write: () => {} };
      const pass = await wakePass({ store, observers: {}, resolveFor });
      expect(pass.errors).toHaveLength(1);
      expect(pass.errors[0].error).toMatch(/not an array/);
      expect(pass.runs).toEqual([]);
    }
  });
});

/**
 * WHAT `unresolved` COSTS, and what now bounds it (PR #1186 round 4, NB4-2 · NB4-3 · NB4-4 · NB4-5 · NB4-7).
 *
 * Nothing writes a status, so nothing ever leaves the scan: 50 parked-forever runs polled every tick, exit 0
 * throughout, and a supervisor watching exit codes never learns. The bound is on REPORTING, never on retrying
 * — nothing is re-dispatched at any age, because retry is #3083 and has no owner.
 */
describe('an unresolved entry is bounded, explained and recorded', () => {
  const parkedAt = (iso) => ({
    v: 1, id: 'run-s', op: OP, input: { pr: 7 }, cursor: 0, findings: {}, verdict: null, telemetry: [],
    pending: { kind: 'effect', step: 'go', stepIndex: 0, count: 1 },
    effects: [{
      key: 'run-s#0#0', stepIndex: 0, step: 'go', index: 0, type: 'start.build', payload: {},
      idempotent: false, dispatch: true, status: 'in-flight', handle: 'sess-abc', startedAt: iso,
      expectedBy: null, result: null, error: null,
    }],
  });

  // The age comes from `startedAt`, which the dispatch already records — the escalation needed no new state.
  it('measures how long it has been stuck from the record, not from a counter', () => {
    const e = parkedAt('2026-08-13T00:00:00.000Z').effects[0];
    expect(hoursStuck(e, '2026-08-13T06:00:00.000Z')).toBeCloseTo(6, 5);
    expect(hoursStuck(e, '2026-08-13T00:30:00.000Z')).toBeCloseTo(0.5, 5);
    expect(hoursStuck({ startedAt: null }, '2026-08-13T06:00:00.000Z')).toBeNull();
  });

  it('ESCALATES past the threshold — a non-zero signal, and a line that says so', async () => {
    const store = createMemoryRunStore();
    store.write(parkedAt('2026-08-13T00:00:00.000Z'));
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'tests red' }) },
      resolveFor: () => ({ registry, sinks: SINKS }),
      now: '2026-08-13T07:00:00.000Z',
    });
    expect(stuckPast(pass)).toHaveLength(1);
    expect(renderPass(pass).join('\n')).toMatch(/ESCALATED — run-s:run-s#0#0 has been unresolved for 7\.0h/);
  });

  it('does NOT escalate inside the threshold', async () => {
    const store = createMemoryRunStore();
    store.write(parkedAt('2026-08-13T00:00:00.000Z'));
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'tests red' }) },
      resolveFor: () => ({ registry, sinks: SINKS }),
      now: '2026-08-13T01:00:00.000Z',
    });
    expect(stuckPast(pass)).toEqual([]);
    expect(renderPass(pass).join('\n')).not.toMatch(/ESCALATED/);
  });

  // NB4-3: the line named no action, and the only recovery the run's own output offers loops forever.
  it('names the close-out call, so the person is told WITH WHAT', async () => {
    const store = createMemoryRunStore();
    store.write(parkedAt('2026-08-13T00:00:00.000Z'));
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'tests red' }) },
      resolveFor: () => ({ registry, sinks: SINKS }),
      now: '2026-08-13T01:00:00.000Z',
    });
    expect(renderPass(pass).join('\n')).toMatch(/resolveInFlight\(run, key/);
  });

  // NB4-5: "writes nothing" was right about the STATUS and wrong about the reason, which lived only in stdout.
  it('records WHY it is unresolved on the record, without writing a status', async () => {
    const store = createMemoryRunStore();
    store.write(parkedAt('2026-08-13T00:00:00.000Z'));
    await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'unresolved', error: 'BUILD FAILED: tests red' }) },
      resolveFor: () => ({ registry, sinks: SINKS }),
    });
    const entry = store.read('run-s').effects[0];
    expect(entry.status).toBe('in-flight');       // still no status written
    expect(entry.observedError).toBe('BUILD FAILED: tests red');
    expect(Number.isNaN(Date.parse(entry.observedAt))).toBe(false);
  });

  // NB4-4: `succeeded` means CLEANLY, so an error alongside it is a contradiction rather than extra detail.
  it('REFUSES a `succeeded` that carries an error, instead of advancing on it', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded', result: { exit: 1 }, error: 'compile error' }) },
    });
    expect(out.run.effects[0].status).toBe('in-flight');
    expect(out.resolved).toEqual([]);
    expect(out.errors[0].error).toMatch(/answered `succeeded` with an error/);
  });

  it('a clean `succeeded` with no error still resolves', async () => {
    const { run } = await parked();
    const out = await observeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded', result: { exit: 0 } }) },
    });
    expect(out.run.effects[0].status).toBe('applied');
  });
});

/**
 * NB4-7, asked in three consecutive rounds: `wakePass`'s per-run catch is labelled belt-and-braces and the
 * suite stayed green with it replaced by a re-throw. It is NOT dead — it is the only thing catching faults
 * that escape `wakeRun`'s own try.
 */
describe('the per-run catch in wakePass is load-bearing', () => {
  it('a throwing store.write inside one run does not take the pass down', async () => {
    const base = createMemoryRunStore();
    const run = advanceWhileRunning(startRun({ op: OP, id: 'run-w', input: { pr: 7 }, registry }), { registry });
    base.write(run);
    const parkedRun = (await applyPendingEffects(run, { sinks: SINKS, store: base })).run;
    base.write(parkedRun);

    const store = {
      list: () => ['run-w'],
      read: (id) => base.read(id),
      write: () => { throw new Error('disk full'); },
    };
    const pass = await wakePass({
      store,
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      resolveFor: () => ({ registry, sinks: SINKS }),
    });
    expect(pass.errors).toEqual([{ runId: 'run-w', error: 'disk full' }]);
    expect(pass.parked).toBe(1);
  });

  it('a null observers table is reported against its run rather than thrown', async () => {
    const { store } = await parked();
    const pass = await wakePass({ store, observers: null, resolveFor: () => ({ registry, sinks: SINKS }) });
    expect(pass.errors).toHaveLength(1);
    expect(pass.errors[0].runId).toBe('run-w');
  });
});

/**
 * THE ONE ARGUMENT THAT PRODUCES EVERY `auto` OBSERVATION (#xou38cr; PR #1195 review, blocking 1). Deleting
 * `attemptedBy: 'auto'` from the waker's `applyPendingEffects` call kept 367 tests green: the gate passes,
 * the waker works, and every automatic retry is filed as human forever. By the time anyone reads the corpus
 * the mislabelled data is gone — which is the exact unrecoverable corruption the item exists to prevent.
 */
describe('the waker labels its own attempts as automatic', () => {
  it('an effect the waker applies is recorded as `auto`', async () => {
    const store = createMemoryRunStore();
    const sinks = {
      'start.build': async () => inFlight({ handle: 'sess-abc' }),
      'note.write': async () => ({ ok: true }),
    };
    let run = advanceWhileRunning(startRun({ op: OP, id: 'run-w', input: { pr: 7 }, registry }), { registry });
    store.write(run);
    // The dispatch itself is applied by the CLI path, so it is human.
    run = (await applyPendingEffects(run, { sinks, store, attemptedBy: 'human' })).run;
    expect(run.effects[0].lastAttemptBy).toBe('human');

    // The waker resolves it and applies the REST of the step — those are its attempts, and they are auto.
    await wakeRun(run, {
      observers: { 'start.build': async () => ({ status: 'succeeded' }) },
      store, registry, sinks,
    });
    const after = store.read('run-w');
    expect(after.effects[1].lastAttemptBy).toBe('auto');
    expect(after.effects[1].autoAttempts).toBe(1);
    expect(after.effects[1].attempts).toBe(1);
  });

  // The same executor, TOLD `human`, must produce the other label — otherwise the split is decorative and
  // the dataset is one population wearing two names.
  //
  // NAMED FOR WHAT IT ACTUALLY DRIVES (PR #1195 round 6). This was called "driven from the command line"
  // and its comment said "driven by the CLI path", but it hand-passes `'human'` to `applyPendingEffects`
  // and never imports `cli-adapter.mjs` — so it asserted nothing about the CLI, and the CLI's own literal
  // could be changed to `'auto'` with the whole suite green. The real CLI path is covered by `an effect
  // applied through the REAL command line is recorded as human` in effect-executor.test.mjs.
  it('the executor told `human` records it, whatever the caller', async () => {
    const store = createMemoryRunStore();
    const sinks = { 'start.build': async () => ({ ok: true }), 'note.write': async () => ({ ok: true }) };
    let run = advanceWhileRunning(startRun({ op: OP, id: 'run-h', input: { pr: 7 }, registry }), { registry });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks, store, attemptedBy: 'human' })).run;
    expect(run.effects.map((e) => e.lastAttemptBy)).toEqual(['human', 'human']);
  });

  // And an omitted caller is `unknown`, never `human` — there is no safe guess (round 3, blocking).
  it('an unstated caller is unknown, not assumed to be a person', async () => {
    const store = createMemoryRunStore();
    const sinks = { 'start.build': async () => ({ ok: true }), 'note.write': async () => ({ ok: true }) };
    let run = advanceWhileRunning(startRun({ op: OP, id: 'run-u', input: { pr: 7 }, registry }), { registry });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks, store })).run;
    expect(run.effects.map((e) => e.lastAttemptBy)).toEqual(['unknown', 'unknown']);
  });
});

/**
 * THE MERGED OBSERVER TABLE. `wake.mjs`'s CLI watches every dispatching effect type through ONE table built by
 * spreading two: the delivery agent's (#3037) and the committee panelist's (#3150). Its safety — that the two
 * are keyed by DISTINCT types, so neither shadows the other — was stated in a comment and defended by nothing
 * (review-pr correctness juror on #1457: CONFIRMED, `impactIfUnfixed: broken`).
 *
 * Why that impact is right, and why a comment was not enough: a spread silently keeps the LAST key. A rename or
 * a copy-paste that collided the two tables would not throw and would not fail a suite — the losing observer
 * would simply never run, so its in-flight work would sit unwatched forever while the pass reported success.
 * These tests exercise the same function the CLI calls, so a collision fails here instead.
 */
describe('the observer table the CLI actually runs', () => {
  it('carries every key from BOTH tables — nothing is shadowed by the spread', () => {
    const dispatch = Object.keys(createDispatchObservers());
    const explore = Object.keys(createExploreObservers());
    const merged = Object.keys(createWakeObservers());

    for (const key of [...dispatch, ...explore]) expect(merged).toContain(key);
    // The count is the assertion that catches a collision: a shadowed key would make the union SHORTER than
    // the sum, and `toContain` alone would still pass.
    expect(merged).toHaveLength(dispatch.length + explore.length);
  });

  it('the two source tables are disjoint, which is the property the spread depends on', () => {
    const dispatch = new Set(Object.keys(createDispatchObservers()));
    const overlap = Object.keys(createExploreObservers()).filter((k) => dispatch.has(k));
    expect(overlap).toEqual([]);
  });

  it('every observer is callable — a table entry that is not a function is a silent no-observer', () => {
    for (const [key, observer] of Object.entries(createWakeObservers())) {
      expect(typeof observer, `observer for ${key}`).toBe('function');
    }
  });
});

// A PERMANENT GUARD REFUSAL AFTER A RESOLVED DISPATCH (PR #6584 red-team). driveRun hands a refusal to advance
// so the engine settles the run refused; the waker used to exit on outcome.error before advancing, leaving
// statuses applied/refused with pending still set: awaiting-effect forever, every later wake a no-op.
describe('wakeRun settles a permanent guard refusal exactly as driveRun does', () => {
  const REFUSE_OP = 'fx-wake-refuse';
  const refuseRegistry = () => {
    const r = createRegistry();
    r.register(op(REFUSE_OP, {
      input: { pr: { type: 'number', required: true } },
      go: effect({
        reads: ['input.pr'],
        effects: () => [
          { type: 'start.build', payload: {}, dispatch: true },
          { type: 'guard.check', payload: {} },
        ],
      }),
    }));
    return r;
  };
  const sinksFor = (guard) => ({ 'start.build': SINKS['start.build'], 'guard.check': guard });
  const observers = { 'start.build': async () => ({ status: 'succeeded', result: { exit: 0 } }) };
  const REFUSAL = 'guard: SELF-CLEAR REFUSED — author cannot clear';

  async function parkedRefuse(guard) {
    const reg = refuseRegistry();
    const store = createMemoryRunStore();
    let run = advanceWhileRunning(startRun({ op: REFUSE_OP, id: 'run-r', input: { pr: 7 }, registry: reg }), { registry: reg });
    store.write(run);
    run = (await applyPendingEffects(run, { sinks: sinksFor(guard), store })).run;
    expect(run.effects[0].status).toBe('in-flight');
    return { run, store, reg };
  }

  it('advances to a terminal refused outcome, and a second wake leaves the settled run alone', async () => {
    const guard = async () => { throw notApplied(REFUSAL); };
    const { run, store, reg } = await parkedRefuse(guard);

    const report = await wakeRun(run, { observers, store, registry: reg, sinks: sinksFor(guard) });
    expect(report.advanced).toBe(true);
    expect(report.status).toBe('complete');
    // Not silent: the refusal is reported once so the wake CLI exits non-zero, as driveRun's effect-refused does.
    expect(report.errors.map((e) => e.error)).toEqual([REFUSAL]);
    const saved = store.read('run-r');
    expect(saved.outcome).toBe('refused');
    expect(saved.pending).toBeNull();
    expect(saved.effects.map((e) => e.status)).toEqual(['applied', 'refused']);

    const again = await wakeRun(saved, { observers, store, registry: reg, sinks: sinksFor(guard) });
    expect(again.status).toBe('complete');
    expect(again.errors).toEqual([]);
    expect(store.read('run-r').outcome).toBe('refused');
  });

  it('never re-invokes the refused guard on a later wake', async () => {
    const guard = vi.fn(async () => { throw notApplied(REFUSAL); });
    const { run, store, reg } = await parkedRefuse(guard);
    await wakeRun(run, { observers, store, registry: reg, sinks: sinksFor(guard) });
    await wakeRun(store.read('run-r'), { observers, store, registry: reg, sinks: sinksFor(guard) });
    expect(guard).toHaveBeenCalledTimes(1);
  });

  // A REFUSAL PERSISTED BEFORE RUN FINALIZATION (PR #6584 round 2): the process stopped after
  // `applyPendingEffects` wrote `refused` and before `advance` cleared `pending`. Nothing is in flight and nothing
  // was observed, so the timer used to skip the record and the run stayed nonterminal indefinitely.
  describe('a refusal persisted before the run was finalized', () => {
    const GUARD_OP = 'fx-wake-guard-only';
    const guardRegistry = () => {
      const r = createRegistry();
      r.register(op(GUARD_OP, {
        input: { pr: { type: 'number', required: true } },
        go: effect({ reads: ['input.pr'], effects: () => [{ type: 'guard.check', payload: {} }] }),
      }));
      return r;
    };

    async function crashedAfterRefusal(guard) {
      const reg = guardRegistry();
      const store = createMemoryRunStore();
      let run = advanceWhileRunning(startRun({ op: GUARD_OP, id: 'run-g', input: { pr: 7 }, registry: reg }), { registry: reg });
      store.write(run);
      // The executor persists `refused`; the process dies before `advance`, so `pending` is still set.
      run = (await applyPendingEffects(run, { sinks: { 'guard.check': guard }, store })).run;
      expect(run.effects[0].status).toBe('refused');
      expect(runStatus(run, { registry: reg })).toBe('awaiting-effect');
      expect(isParkedOnDispatch(run)).toBe(false);
      return { run, store, reg };
    }

    it('wakePass finds it and settles it refused, reporting the refusal once', async () => {
      const guard = vi.fn(async () => { throw notApplied(REFUSAL); });
      const { store, reg } = await crashedAfterRefusal(guard);
      const resolveFor = () => ({ registry: reg, sinks: { 'guard.check': guard } });

      const pass = await wakePass({ store, observers: {}, resolveFor });
      expect(pass.parked).toBe(1);
      expect(pass.runs[0].advanced).toBe(true);
      expect(pass.runs[0].status).toBe('complete');
      expect(pass.runs[0].errors.map((e) => e.error)).toEqual([REFUSAL]);
      const saved = store.read('run-g');
      expect(saved.outcome).toBe('refused');
      expect(saved.pending).toBeNull();

      // Settled: a later tick neither picks it up again nor repeats the report, and never re-invokes the guard.
      const again = await wakePass({ store, observers: {}, resolveFor });
      expect(again.parked).toBe(0);
      expect(again.runs).toEqual([]);
      expect(guard).toHaveBeenCalledTimes(1);
    });

    it('wakeRun settles it directly even though nothing was observed', async () => {
      const guard = async () => { throw notApplied(REFUSAL); };
      const { run, store, reg } = await crashedAfterRefusal(guard);
      const report = await wakeRun(run, { observers: {}, store, registry: reg, sinks: { 'guard.check': guard } });
      expect(report.advanced).toBe(true);
      expect(report.status).toBe('complete');
      expect(store.read('run-g').outcome).toBe('refused');
    });

    it('a non-permanent failure on an unfinalized run is NOT picked up as a refusal', async () => {
      const { run } = await crashedAfterRefusal(async () => { throw notApplied(REFUSAL); });
      // Same shape, but a plain `failed` entry (or a `refused` one with no recognized marker): not the refusal path.
      const failedRun = { ...run, effects: run.effects.map((e) => ({ ...e, status: 'failed', error: 'transient: try again' })) };
      expect(isParkedUnsettled(failedRun)).toBe(false);
      const unmarked = { ...run, effects: run.effects.map((e) => ({ ...e, error: 'some other refusal' })) };
      expect(isParkedUnsettled(unmarked)).toBe(false);
      // A settled (terminal) refusal is not parked either.
      expect(isParkedUnsettled({ ...run, pending: null })).toBe(false);
    });

    // THE WAKER SELECTS BY THE ENGINE'S OWN TEST (self-review of round 2): a refusal that `advance` would not
    // settle must not be picked up, or the timer retries sinks and re-reports it on every tick forever.
    it('is scoped to the pending step and to what advance can settle — never a refusal advance would ignore', async () => {
      const guard = async () => { throw notApplied(REFUSAL); };
      const { run } = await parkedRefuse(guard); // [start.build in-flight, guard.check declared], pending step 0
      const refusal = { status: 'refused', attempts: 1, error: REFUSAL };
      const withEffects = (patch) => ({ ...run, effects: run.effects.map((e, i) => ({ ...e, ...patch[i] })) });

      // Refusal behind an in-flight sibling: the observer path owns it, advance cannot settle it.
      expect(isParkedUnsettled(withEffects([{}, refusal]))).toBe(false);
      // Refusal behind an earlier `failed` sibling (the executor would retry it every tick).
      expect(isParkedUnsettled(withEffects([{ status: 'failed', error: 'x' }, refusal]))).toBe(false);
      // Refusal in front of an untried `declared` sibling is settleable (the engine ignores the tail).
      expect(isParkedUnsettled(withEffects([{ status: 'applied' }, refusal]))).toBe(true);
      expect(isParkedUnsettled(withEffects([{ ...refusal, status: 'refused' }, { status: 'declared' }]))).toBe(true);
      // A refusal recorded against a DIFFERENT step says nothing about the pending one.
      const elsewhere = withEffects([{ status: 'failed', error: 'x' }, { ...refusal, stepIndex: 99 }]);
      expect(isParkedUnsettled(elsewhere)).toBe(false);
    });

    it('an unfinalized refusal behind a failed sibling is left alone by the pass: no retry, no report', async () => {
      const guard = vi.fn(async () => { throw notApplied(REFUSAL); });
      const { run, store, reg } = await parkedRefuse(guard);
      store.write({ ...run, effects: run.effects.map((e, i) => (i === 0
        ? { ...e, status: 'failed', error: 'x' }
        : { ...e, status: 'refused', attempts: 1, error: REFUSAL })) });
      const pass = await wakePass({ store, observers: {}, resolveFor: () => ({ registry: reg, sinks: sinksFor(guard) }) });
      expect(pass.parked).toBe(0);
      expect(pass.errors).toEqual([]);
      expect(guard).not.toHaveBeenCalled();
    });

    // THE ANTI-SPIN BREAK (PR #6584 round 4): wakeRun called directly on a refusal `advance` cannot settle (an
    // attempted sibling still `pending` behind it) must report ONCE and stop, not re-apply the refusal each turn.
    it('wakeRun stops after one report when advance cannot settle the refusal (no turn-cap spin)', async () => {
      const TWO_OP = 'fx-wake-two-guards';
      const reg = createRegistry();
      reg.register(op(TWO_OP, {
        input: { pr: { type: 'number', required: true } },
        go: effect({ reads: ['input.pr'], effects: () => [
          { type: 'start.build', payload: {}, dispatch: true },
          { type: 'guard.check', payload: {} },
          { type: 'guard.other', payload: {} },
        ] }),
      }));
      const guard = vi.fn(async () => { throw notApplied(REFUSAL); });
      const other = vi.fn(async () => ({ ok: true }));
      const sinks = { 'start.build': SINKS['start.build'], 'guard.check': guard, 'guard.other': other };
      const store = createMemoryRunStore();
      let run = advanceWhileRunning(startRun({ op: TWO_OP, id: 'run-t', input: { pr: 7 }, registry: reg }), { registry: reg });
      store.write(run);
      run = (await applyPendingEffects(run, { sinks, store })).run; // parks on the dispatch (start.build in-flight)
      expect(run.effects[0].status).toBe('in-flight');
      // A sibling attempted earlier whose outcome is unknown sits behind the guard the executor will refuse first,
      // so advance cannot settle the refusal. Reaching the loop needs a resolved dispatch (else wakeRun returns
      // early), which `observers` supplies.
      run = { ...run, effects: run.effects.map((e, i) => (i === 2 ? { ...e, status: 'failed', attempts: 1, error: 'transient: try again' } : e)) };
      store.write(run);
      const report = await wakeRun(run, { observers, store, registry: reg, sinks });
      expect(guard).toHaveBeenCalledTimes(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].error).toBe(REFUSAL);
      expect(report.status).toBe('awaiting-effect');
    });

    // THE SAME CLASS, ANOTHER MEMBER: every effect of the step durably `applied` (the waker's own observer write,
    // a last sink write, a `--resolve` close-out), process gone before `advance` cleared `pending`.
    it('wakePass finishes a step whose effects are all applied but whose pending was never cleared', async () => {
      const guard = vi.fn(async () => ({ ok: true }));
      const { run, store, reg } = await parkedRefuse(guard);
      const stuck = { ...run, effects: run.effects.map((e) => ({ ...e, status: 'applied', result: { ok: true } })) };
      store.write(stuck);
      expect(runStatus(stuck, { registry: reg })).toBe('awaiting-effect');
      expect(isParkedOnDispatch(stuck)).toBe(false);

      const resolveFor = () => ({ registry: reg, sinks: sinksFor(guard) });
      const pass = await wakePass({ store, observers: {}, resolveFor });
      expect(pass.parked).toBe(1);
      expect(pass.runs[0].advanced).toBe(true);
      expect(pass.runs[0].status).toBe('complete');
      expect(pass.runs[0].errors).toEqual([]);
      const saved = store.read('run-r');
      expect(saved.pending).toBeNull();
      expect(saved.outcome ?? null).toBeNull();
      expect(guard).not.toHaveBeenCalled();

      expect((await wakePass({ store, observers: {}, resolveFor })).parked).toBe(0);
    });
  });

  it('an ordinary (non-permanent) failure still stops the pass and reports the error, unchanged', async () => {
    const guard = async () => { throw new Error('network down'); };
    const { run, store, reg } = await parkedRefuse(guard);
    const report = await wakeRun(run, { observers, store, registry: reg, sinks: sinksFor(guard) });
    expect(report.errors.map((e) => e.error)).toEqual(['network down']);
    expect(store.read('run-r').outcome ?? null).toBeNull();
    expect(report.status).toBe('awaiting-effect');
  });
});
