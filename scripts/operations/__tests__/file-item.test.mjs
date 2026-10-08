/**
 * @file file-item.test.mjs — the `file-item` declaration (#3383).
 *
 * THREE PROPERTIES CARRY THIS FILE:
 *   1. THE SCAFFOLD VERDICT IS UNCHANGED — `plan` here must produce byte-identical output to
 *      `scaffold.mjs#planScaffold` for the same input, because this operation reuses it directly rather than
 *      re-deriving it (its own header says so; this pins the claim).
 *   2. THE QUEUEING DECISION is exercised on its own (`planQueueing`), each refusal reason named, mirroring
 *      how `scaffold.test.mjs` names every one of `planScaffold`'s refusal reasons.
 *   3. THE DECLARATION END TO END drives BOTH effects (or just the write, when queueing is refused) through a
 *      real `advance` loop, proving the two-effect shape actually reaches two sinks — not just that each
 *      helper function is individually correct.
 */
import { describe, it, expect } from 'vitest';
import { NON_DISPATCHABLE_KINDS as QUEUE_NON_DISPATCHABLE_KINDS } from '../../conveyor/queue.mjs';

import { advanceWhileRunning, startRun, runStatus } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { planScaffold, shapeScaffoldRead, SCAFFOLD_EFFECT } from '../scaffold.mjs';
import {
  planQueueing, NON_DISPATCHABLE_KINDS, fileItemOperation, FILE_ITEM_OP, FILE_ITEM_QUEUE_EFFECT,
} from '../file-item.mjs';

const read = (over = {}) => shapeScaffoldRead({
  existingIds: ['001', '002', 'xabc123'],
  today: '2026-08-21',
  dir: '/repo/backlog',
  ...over,
});

describe('NON_DISPATCHABLE_KINDS agrees with what queue.mjs flags as non-dispatchable', () => {
  it('matches the keys of the conveyor CLI warning map', () => {
    expect(new Set(NON_DISPATCHABLE_KINDS)).toEqual(new Set(QUEUE_NON_DISPATCHABLE_KINDS));
  });
});

describe('planQueueing', () => {
  it('queues a plain story/task born open', () => {
    const verdict = planScaffold(read(), { workItem: 'task', title: 't' });
    expect(planQueueing(verdict, {})).toEqual({ queueing: true, reason: expect.stringContaining('ready to clear') });
  });

  it('refuses an epic — `/slice` it first', () => {
    const verdict = planScaffold(read(), { kind: 'epic', title: 'an epic' });
    const r = planQueueing(verdict, {});
    expect(r.queueing).toBe(false);
    expect(r.reason).toMatch(/slice/);
  });

  it('refuses a decision — `/prepare` + `/decision` first', () => {
    const verdict = planScaffold(read(), { kind: 'decision', title: 'a decision' });
    const r = planQueueing(verdict, {});
    expect(r.queueing).toBe(false);
    expect(r.reason).toMatch(/prepare/);
  });

  it('refuses a session-born (active, #670) card — pool-excluded until settled', () => {
    const verdict = planScaffold(read(), { workItem: 'task', title: 't', session: 'sess-1' });
    expect(verdict.status).toBe('active');
    const r = planQueueing(verdict, {});
    expect(r.queueing).toBe(false);
    expect(r.reason).toMatch(/settled/);
  });

  it('respects an explicit `--queue=false` opt-out', () => {
    const verdict = planScaffold(read(), { workItem: 'task', title: 't' });
    expect(planQueueing(verdict, { queue: 'false' }).queueing).toBe(false);
    expect(planQueueing(verdict, { queue: '0' }).queueing).toBe(false);
  });

  it('defaults to queueing when `queue` is omitted entirely', () => {
    const verdict = planScaffold(read(), { workItem: 'task', title: 't' });
    expect(planQueueing(verdict, {}).queueing).toBe(true);
  });
});

describe('the declaration end to end', () => {
  function buildRegistry(readerOverrides = {}) {
    const registry = createRegistry();
    registry.register(fileItemOperation({
      readScaffoldContext: () => ({ existingIds: ['001'], today: '2026-08-21', dir: '/repo/backlog', ...readerOverrides }),
    }));
    return registry;
  }

  // TWO SEQUENTIAL effect steps (`write` then `queueAdd`) means the run SUSPENDS after each one until it is
  // applied — the executor halts at the first in-flight effect (see `explore.test.mjs`'s own driving loop for
  // the precedent). One `applyPendingEffects` + `advanceWhileRunning` round only clears the FIRST step; this
  // loops until the run is no longer `awaiting-effect`, so both sinks actually get called.
  async function runToCompletion(run, { registry, sinks, store }) {
    for (let i = 0; i < 10 && runStatus(run, { registry }) === 'awaiting-effect'; i += 1) {
      const applied = await applyPendingEffects(run, { registry, sinks, store });
      run = applied.run;
      run = advanceWhileRunning(run, { registry });
    }
    return run;
  }

  it('drives read → plan → queuePlan → write + queueAdd, hitting BOTH sinks for a plain task', async () => {
    const registry = buildRegistry();
    const written = [];
    const queued = [];
    const sinks = {
      [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; },
      [FILE_ITEM_QUEUE_EFFECT]: async (p) => { queued.push(p); return { num: p.num, queued: true }; },
    };

    let run = advanceWhileRunning(startRun({
      op: FILE_ITEM_OP, id: 'run-fi-1',
      input: { title: 'A new task', workItem: 'task', digest: 'why it exists' },
      registry,
    }), { registry });
    run = await runToCompletion(run, { registry, sinks, store: createMemoryRunStore() });

    expect(written).toHaveLength(1);
    expect(written[0].rel).toMatch(/^backlog\/x[a-z0-9]+-a-new-task\.md$/);
    expect(queued).toHaveLength(1);
    expect(queued[0].num).toBe(run.verdict.num);
    // The verdict is scaffold's own shape, unchanged — a caller of `scaffold` and a caller of `file-item`
    // read the identical fields off `run.verdict` for the same input.
    expect(run.verdict.kind).toBe('task');
    expect(run.verdict.status).toBe('open');
  });

  it.each(QUEUE_NON_DISPATCHABLE_KINDS)('files a %s — writes the card but declares NO queue effect', async (kind) => {
    const registry = buildRegistry();
    const written = [];
    const queued = [];
    const sinks = {
      [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; },
      [FILE_ITEM_QUEUE_EFFECT]: async (p) => { queued.push(p); return { num: p.num, queued: true }; },
    };

    let run = advanceWhileRunning(startRun({
      op: FILE_ITEM_OP, id: 'run-fi-2',
      input: { title: `A ${kind}`, kind, digest: 'why it exists' },
      registry,
    }), { registry });
    run = await runToCompletion(run, { registry, sinks, store: createMemoryRunStore() });

    expect(written).toHaveLength(1); // still filed
    expect(run.verdict.kind).toBe(kind);
    expect(queued).toHaveLength(0); // never cleared — the conveyor can't build this kind
  });

  // #x0h3pe4 — the exact bug: `file-item --kind=decision --size=2` wrote a card with no `size:` line.
  it('a sized decision is WRITTEN with its size (never silently dropped)', async () => {
    const registry = buildRegistry();
    const written = [];
    const sinks = {
      [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; },
      [FILE_ITEM_QUEUE_EFFECT]: async (p) => ({ num: p.num, queued: true }),
    };
    let run = advanceWhileRunning(startRun({
      op: FILE_ITEM_OP, id: 'run-fi-size',
      input: { title: 'Sized decision', kind: 'decision', size: '2', digest: 'x', queue: 'false' },
      registry,
    }), { registry });
    run = await runToCompletion(run, { registry, sinks, store: createMemoryRunStore() });
    expect(written).toHaveLength(1);
    expect(written[0].content).toMatch(/^size: 2$/m);
  });

  it('respects `--queue=false`: writes the card, never calls the queue sink at all', async () => {
    const registry = buildRegistry();
    const written = [];
    let queueSinkCalled = false;
    const sinks = {
      [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; },
      [FILE_ITEM_QUEUE_EFFECT]: async (p) => { queueSinkCalled = true; return { num: p.num, queued: true }; },
    };

    let run = advanceWhileRunning(startRun({
      op: FILE_ITEM_OP, id: 'run-fi-3',
      input: { title: 'Opt out', workItem: 'task', digest: 'x', queue: 'false' },
      registry,
    }), { registry });
    run = await runToCompletion(run, { registry, sinks, store: createMemoryRunStore() });

    expect(written).toHaveLength(1);
    expect(queueSinkCalled).toBe(false);
  });

  it('refuses to build without an injected reader', () => {
    expect(() => fileItemOperation({})).toThrow(/needs a `readScaffoldContext/);
  });
});
