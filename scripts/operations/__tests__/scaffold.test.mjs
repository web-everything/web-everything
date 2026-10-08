/**
 * @file scaffold.test.mjs — the `scaffold` declaration (#xrrpfo7), the BIRTH of the lifecycle whose open is
 * `claim` and whose close is `resolve`.
 *
 * TWO PROPERTIES CARRY THIS FILE:
 *
 *   1. **THE LEGACY FLAG SHAPE STILL RESOLVES.** `--type`/`--workitem` predate the single `kind` axis and
 *      every skill in the repo still passes them — including the 45 calls that motivated this operation.
 *      Silently retyping those items would be the worst possible regression, so the precedence is asserted
 *      case by case rather than assumed.
 *   2. **THE #2288 ID ALLOCATION IS COLLISION-SAFE**, and the retry is reachable here in a way it never is
 *      against a real filesystem: the existing-id set is injected, so a collision can simply be constructed.
 *
 * Nothing here touches `fs` — the reader is a plain function returning a fixture.
 */
import { describe, it, expect } from 'vitest';

import { advanceWhileRunning, startRun } from '../engine.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createRegistry } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import {
  planScaffold, resolveKind, normalizeRef, slugFor, shapeScaffoldRead,
  scaffoldOperation, SCAFFOLD_OP, SCAFFOLD_EFFECT, SCAFFOLD_REFUSALS,
} from '../scaffold.mjs';

const read = (over = {}) => shapeScaffoldRead({
  existingIds: ['001', '002', 'xabc123'],
  today: '2026-08-21',
  dir: '/repo/backlog',
  ...over,
});

const reasonOf = (fn) => { try { fn(); return null; } catch (e) { return e.reason ?? 'threw-without-reason'; } };

describe('the legacy flag shape still resolves to the right kind', () => {
  // Each case named, because a silent retype across 45 call sites is the regression that matters most here.
  it('an explicit `kind` wins over everything', () => {
    expect(resolveKind({ kind: 'epic', type: 'decision', workItem: 'story' })).toBe('epic');
  });

  it('`type: decision` wins over `workItem` — a decision is a decision whatever the workItem says', () => {
    expect(resolveKind({ type: 'decision', workItem: 'story' })).toBe('decision');
    expect(resolveKind({ type: 'decision', workItem: 'task' })).toBe('decision');
  });

  it('otherwise `workItem` carries the kind', () => {
    expect(resolveKind({ type: 'issue', workItem: 'task' })).toBe('task');
    expect(resolveKind({ type: 'issue', workItem: 'epic' })).toBe('epic');
  });

  it('`type` alone with no workItem falls back to story, not to `type`', () => {
    // `--type=issue` is NOT a kind — `issue` is not in BACKLOG_KINDS. The CLI treats a bare `--type` as
    // "some non-decision thing" and defaults the kind to story; asserting it stops a later "obvious" fix
    // from turning 45 existing calls into refusals.
    expect(resolveKind({ type: 'issue' })).toBe('story');
  });

  it('nothing at all is a story', () => {
    expect(resolveKind({})).toBe('story');
    expect(resolveKind()).toBe('story');
  });
});

describe('refusals', () => {
  it('a kind outside the gate\'s own set REFUSES', () => {
    expect(reasonOf(() => planScaffold(read(), { kind: 'chore', title: 'x' }))).toBe('bad-kind');
  });

  it('no title REFUSES', () => {
    expect(reasonOf(() => planScaffold(read(), { title: '   ' }))).toBe('no-title');
  });

  it('a story with no size REFUSES — it would enter the board unrankable', () => {
    expect(reasonOf(() => planScaffold(read(), { title: 'a story' }))).toBe('story-needs-size');
  });

  it('…but a task with no size is fine', () => {
    // The other half. Without it, "always require a size" would pass the test above.
    expect(planScaffold(read(), { workItem: 'task', title: 'a task' }).kind).toBe('task');
  });

  // #x0h3pe4 — a passed --size is never silently dropped: kept where the kind may carry one, refused otherwise.
  it.each(['decision', 'epic', 'investigation'])('a sized %s KEEPS its size in the written frontmatter', (kind) => {
    expect(planScaffold(read(), { kind, title: 'x', size: '2' }).content).toMatch(/^size: 2$/m);
  });

  it.each(['task', 'feature'])('a sized %s REFUSES loudly instead of dropping the size', (kind) => {
    expect(reasonOf(() => planScaffold(read(), { kind, title: 'x', size: '2' }))).toBe('size-not-allowed');
  });

  it('a non-numeric size REFUSES instead of dropping it', () => {
    expect(reasonOf(() => planScaffold(read(), { kind: 'decision', title: 'x', size: 'big' }))).toBe('bad-size');
  });

  it('every refusal reason is in the declared set', () => {
    const cases = [
      { kind: 'chore', title: 'x' }, { title: '' }, { title: 'a story' },
      { kind: 'task', title: 'x', size: '2' }, { kind: 'decision', title: 'x', size: 'big' },
    ];
    for (const c of cases) expect(SCAFFOLD_REFUSALS).toContain(reasonOf(() => planScaffold(read(), c)));
  });
});

describe('#2288 id allocation', () => {
  it('allocates a HASH, never max+1', () => {
    const v = planScaffold(read(), { workItem: 'task', title: 'a task' });
    expect(v.num).toMatch(/^x[a-z0-9]+$/);
    expect(v.num).not.toBe('003');
  });

  it('never collides with an existing id, including RESOLVED ones', () => {
    // The id set deliberately includes every card, not just open ones: filtering to open would let the
    // allocator hand back an id a resolved card already owns, and two cards sharing an id is unrecoverable.
    const ids = Array.from({ length: 200 }, (_, i) => `x${i.toString(36)}zz`);
    const v = planScaffold(read({ existingIds: ids }), { workItem: 'task', title: 't' });
    expect(ids).not.toContain(v.num);
  });

  it('RETRIES once on a collision and succeeds', () => {
    // A stub that returns a taken id first, then a free one — the retry path, driven rather than hoped for.
    const calls = [];
    const alloc = (ids) => { calls.push(ids.length); return calls.length === 1 ? 'xtaken' : 'xfree'; };
    const v = planScaffold(read({ existingIds: ['xtaken'] }), { workItem: 'task', title: 't' }, { alloc });
    expect(v.num).toBe('xfree');
    // The second call was given the AUGMENTED set, so the allocator can see what it just collided with.
    expect(calls).toEqual([1, 2]);
  });

  it('REFUSES rather than looping when the allocator returns a taken id twice', () => {
    // The earlier cut of this test asserted `null` — i.e. no refusal — under a name promising one, so it
    // tested the opposite of its title and the `id-exhausted` branch had never executed. `alloc` is
    // injectable for exactly this: an untested refusal is one you are guessing about.
    const alloc = () => 'xtaken';
    expect(reasonOf(() => planScaffold(read({ existingIds: ['xtaken'] }), { workItem: 'task', title: 't' }, { alloc })))
      .toBe('id-exhausted');
  });
});

describe('cross-references are normalized, and a hash is NOT padded', () => {
  it('pads a number, leaves a hash alone', () => {
    expect(normalizeRef('7')).toBe('007');
    expect(normalizeRef('#42')).toBe('042');
    // THE ONE THAT MATTERS: zero-padding `xvatzyf` corrupts it into an id that resolves to nothing, which
    // then reads as a dangling edge rather than as the mangling it is.
    expect(normalizeRef('xvatzyf')).toBe('xvatzyf');
    expect(normalizeRef('#xvatzyf')).toBe('xvatzyf');
  });

  it('carries mixed refs through to the rendered card unmangled', () => {
    const v = planScaffold(read(), { workItem: 'task', title: 't', blockedBy: '7, xvatzyf , 12' });
    expect(v.content).toMatch(/blockedBy:.*007/);
    expect(v.content).toMatch(/blockedBy:.*xvatzyf/);
    expect(v.content).not.toMatch(/00xvatzyf/);
  });
});

describe('the two births (#670)', () => {
  it('without a session the item is born OPEN', () => {
    expect(planScaffold(read(), { workItem: 'task', title: 't' }).status).toBe('open');
  });

  it('with a session it is born ACTIVE and pool-excluded until settled', () => {
    // A half-authored card must not be offered to another session's batch pool.
    const v = planScaffold(read(), { workItem: 'task', title: 't', session: 'sess-1' });
    expect(v.status).toBe('active');
    expect(v.content).toMatch(/scaffoldedBy/);
  });
});

describe('the read refuses rather than allocating against nothing', () => {
  it('a reader with no `existingIds` throws', () => {
    // Allocating against an absent set would "succeed" and could hand back a taken id.
    expect(() => shapeScaffoldRead({ today: '2026-08-21' })).toThrow(/must return `existingIds`/);
  });

  it('a non-object reader result throws', () => {
    for (const bad of [null, undefined, 'x', 7]) expect(() => shapeScaffoldRead(bad)).toThrow(/not a scaffold context/);
  });
});

describe('slugs', () => {
  it('lowercases, collapses punctuation, and never trails a hyphen', () => {
    expect(slugFor('Gate: rank tables — null-prototype!')).toBe('gate-rank-tables-null-prototype');
  });

  it('an explicit slug overrides the derived one', () => {
    expect(planScaffold(read(), { workItem: 'task', title: 'Long title here', slug: 'short' }).rel)
      .toMatch(/-short\.md$/);
  });
});

describe('the declaration end to end', () => {
  it('drives read → plan → write and hands the sink bytes it did not choose', async () => {
    const registry = createRegistry();
    registry.register(scaffoldOperation({
      readScaffoldContext: () => ({ existingIds: ['001'], today: '2026-08-21', dir: '/repo/backlog' }),
    }));
    const written = [];
    const sinks = { [SCAFFOLD_EFFECT]: async (p) => { written.push(p); return { rel: p.rel, written: true }; } };

    let run = advanceWhileRunning(startRun({
      op: SCAFFOLD_OP, id: 'run-sc',
      input: { title: 'A new task', workItem: 'task', digest: 'why it exists' },
      registry,
    }), { registry });
    ({ run } = await applyPendingEffects(run, { registry, sinks, store: createMemoryRunStore() }));

    expect(written).toHaveLength(1);
    expect(written[0].rel).toMatch(/^backlog\/x[a-z0-9]+-a-new-task\.md$/);
    // The sink writes what `plan` computed — it decides nothing.
    expect(written[0].content).toBe(run.verdict.content);
    expect(run.verdict.digestFilled).toBe(true);
  });

  it('refuses to build without an injected reader', () => {
    expect(() => scaffoldOperation({})).toThrow(/needs a `readScaffoldContext/);
  });
});
