/**
 * @file scripts/readiness/__tests__/overlap-chain.test.mjs
 * @description Unit proof of #2394's pure overlap-stacking planner (`overlap-chain.mjs`): selective
 *   union-find chaining on DECLARED file-sets (sibling / stack-on-frontier / bridge), the depth cap's
 *   sibling fallback + CAPPED re-root (a conflict-bound cluster nothing may stack on for the rest of the
 *   plan), the capability gate's hard default to siblings, and the push-time
 *   `actual ⊆ declared` re-check verdicts (clean / undeclared-disjoint / rebase-required) with the
 *   apply-rebase repair loop. The git/fs boundary lives in `we:scripts/lane-stack.mjs`, e2e-proven in
 *   `we:scripts/__tests__/lane-stack-e2e.test.mjs`.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEPTH_CAP, createStackPlan, planNextItem, recheckAtPush, applyRebase, recordPushed, dropItem, firstScopeOverlap, overlapsInFlight,
} from '../overlap-chain.mjs';

const push = (plan, id, files = [], tips = { we: { sha: `sha-${id}`, ref: `lane/x-${id}` } }) =>
  recordPushed(plan, { id, actualFiles: files, tips });

describe('capability gate (#2387 F4) — default hard to siblings', () => {
  it('plans every item a sibling when unsupported, even with obvious overlap', () => {
    const plan = createStackPlan({ supported: false });
    const a = planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    const b = planNextItem(plan, { id: 'B', files: ['we:shared.txt'] });
    expect(a.stacked).toBe(false);
    expect(b.stacked).toBe(false);
    expect(b.stackParents).toEqual([]);
    expect(b.reason).toMatch(/stacking-unsupported/);
  });

  it('disarms the rebase directive at recheck (a rebase would CREATE an ungated stacked PR)', () => {
    const plan = createStackPlan({ supported: false });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    planNextItem(plan, { id: 'B', files: ['we:b.txt'] });
    const v = recheckAtPush(plan, { id: 'B', actualFiles: ['we:b.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('stacking-unsupported');
    expect(v.undeclared).toEqual(['we:shared.txt']); // still reported for the ledger
    expect(v.onto).toEqual([]);
  });
});

describe('selective chaining (#2387 F1)', () => {
  it('overlap stacks on the frontier tip; disjoint stays a sibling; frontier advances per push', () => {
    const plan = createStackPlan({ supported: true });
    const a = planNextItem(plan, { id: 'A', files: ['we:shared.txt', 'we:a.txt'] });
    expect(a.stacked).toBe(false);
    push(plan, 'A', ['we:shared.txt', 'we:a.txt']);

    const b = planNextItem(plan, { id: 'B', files: ['we:shared.txt', 'we:b.txt'] });
    expect(b.stacked).toBe(true);
    expect(b.base).toBe('A');
    expect(b.stackParents).toEqual(['A']);
    expect(b.baseTips).toEqual({ we: { sha: 'sha-A', ref: 'lane/x-A' } }); // the concrete acquire --base
    push(plan, 'B', ['we:shared.txt', 'we:b.txt']);

    const d = planNextItem(plan, { id: 'D', files: ['we:d.txt'] });
    expect(d.stacked).toBe(false); // provably disjoint — sibling off origin/main even mid-chain

    const c = planNextItem(plan, { id: 'C', files: ['we:shared.txt', 'we:c.txt'] });
    expect(c.base).toBe('B'); // the frontier moved past A
    expect(c.stackParents).toEqual(['B']);
  });

  it('stacks on files a predecessor ACTUALLY touched, not just declared (recordPushed absorbs actuals)', () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:a.txt'] });
    push(plan, 'A', ['we:a.txt', 'we:surprise.txt']); // undeclared-disjoint excess, pushed anyway
    const b = planNextItem(plan, { id: 'B', files: ['we:surprise.txt'] });
    expect(b.stacked).toBe(true);
    expect(b.base).toBe('A');
  });

  it('the same path in two repos never collides (repo-qualified sets)', () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:src/index.ts'] });
    push(plan, 'A', ['we:src/index.ts']);
    const b = planNextItem(plan, { id: 'B', files: ['frontierui:src/index.ts'] });
    expect(b.stacked).toBe(false);
  });

  it('a bridging item merges two chains and records BOTH frontier tips as stackParents', () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:a.txt'] });
    push(plan, 'A', ['we:a.txt']);
    planNextItem(plan, { id: 'B', files: ['we:b.txt'] });
    push(plan, 'B', ['we:b.txt']);

    const e = planNextItem(plan, { id: 'E', files: ['we:a.txt', 'we:b.txt'] });
    expect(e.stacked).toBe(true);
    expect(new Set(e.stackParents)).toEqual(new Set(['A', 'B']));
    expect(e.mergeParents.length).toBe(1); // base on one tip, merge the other in-session
    push(plan, 'E', ['we:a.txt', 'we:b.txt']);

    // The chains fused: an item touching either side now stacks on the bridge, one chain.
    const f = planNextItem(plan, { id: 'F', files: ['we:b.txt'] });
    expect(f.base).toBe('E');
    expect(f.stackParents).toEqual(['E']);
  });

  it('an unpushed (dropped) root is overlap-visible but never stacked on', () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:a.txt'] });
    dropItem(plan, { id: 'A' }); // gate-red / carried — no PR, no tip
    const b = planNextItem(plan, { id: 'B', files: ['we:a.txt'] });
    expect(b.stacked).toBe(false);
    expect(b.reason).toMatch(/no pushed frontier/);
  });

  it('recordPushed fuses a frontier-less (dropped-root) overlap for visibility WITHOUT capping — still stackable', () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    dropItem(plan, { id: 'A' }); // carried — its chain stays live but frontier-less
    const b = planNextItem(plan, { id: 'B', files: ['we:shared.txt'] });
    expect(b.stacked).toBe(false); // nothing pushed to stack on
    push(plan, 'B', ['we:shared.txt']);
    // The two shared.txt chains fused at record; no pushed-vs-pushed conflict exists, so the fused chain is
    // NOT capped and C stacks on B normally.
    const c = planNextItem(plan, { id: 'C', files: ['we:shared.txt'] });
    expect(c.stacked).toBe(true);
    expect(c.base).toBe('B');
  });
});

describe('depth cap — sibling fallback + capped re-root (never stackable)', () => {
  const cappedPlan = () => {
    const plan = createStackPlan({ supported: true, depthCap: 2 });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    const b = planNextItem(plan, { id: 'B', files: ['we:shared.txt'] });
    expect(b.stacked).toBe(true);
    push(plan, 'B', ['we:shared.txt']);

    const c = planNextItem(plan, { id: 'C', files: ['we:shared.txt'] });
    expect(c.stacked).toBe(false); // depth would be 3 > cap 2
    expect(c.reason).toMatch(/depth cap/);
    push(plan, 'C', ['we:shared.txt']);
    return plan;
  };

  it(`defaults to ${DEFAULT_DEPTH_CAP}; past the cap the fallback sibling re-roots a CAPPED chain no later item stacks on`, () => {
    const plan = cappedPlan();
    // C's history is conflict-bound with the pushed frontier B (both edit shared.txt off different bases) —
    // the drain WILL rewrite C at land. Stacking D on C would certify a clean lineage that rewrite falsifies,
    // so D must be a sibling too (each capped-cluster member pays its own drain rebase — today's cost).
    const d = planNextItem(plan, { id: 'D', files: ['we:shared.txt'] });
    expect(d.stacked).toBe(false);
    expect(d.stackParents).toEqual([]);
    expect(d.reason).toMatch(/depth-capped/);
    push(plan, 'D', ['we:shared.txt']);

    // The capped flag is sticky for the whole plan: E after D is still a sibling.
    const e = planNextItem(plan, { id: 'E', files: ['we:shared.txt'] });
    expect(e.stacked).toBe(false);
  });

  it('the cap binds on the RECHECK path too — excess onto an at-cap frontier is undeclared-capped, never an over-cap rebase (#2394 r2)', () => {
    const plan = createStackPlan({ supported: true, depthCap: 2 });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    expect(planNextItem(plan, { id: 'B', files: ['we:shared.txt'] }).stacked).toBe(true);
    push(plan, 'B', ['we:shared.txt']); // chain now AT the cap (depth 2)

    // E DECLARES disjoint (planNextItem's cap never fires) but actually touches the chain's hot file — the
    // rebase-required → applyRebase path would grow the chain to depth 3, 4, … unbounded without this guard.
    planNextItem(plan, { id: 'E', files: ['we:e.txt'] });
    const v = recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(true);
    expect(v.verdict, 'rebase directive disarmed: fusing would exceed depthCap').toBe('undeclared-capped');
    expect(v.onto).toEqual([]);

    // Pushed as the sibling it is, the cluster fuses and goes CAPPED — later items cannot stack either.
    push(plan, 'E', ['we:e.txt', 'we:shared.txt']);
    const f = planNextItem(plan, { id: 'F', files: ['we:shared.txt'] });
    expect(f.stacked).toBe(false);
    expect(f.reason).toMatch(/depth-capped/);
  });

  it('at exactly the cap the recheck still directs the rebase (fused depth == depthCap is allowed)', () => {
    const plan = createStackPlan({ supported: true, depthCap: 2 });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']); // depth 1
    planNextItem(plan, { id: 'E', files: ['we:e.txt'] });
    const v = recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('rebase-required'); // fused depth would be 2 = cap — still bounded
    expect(v.onto).toEqual(['A']);
  });

  it('recheck excess touching a capped cluster is undeclared-capped — rebase directive disarmed, push as sibling', () => {
    const plan = cappedPlan();
    planNextItem(plan, { id: 'G', files: ['we:g.txt'] }); // declared-disjoint sibling
    const v = recheckAtPush(plan, { id: 'G', actualFiles: ['we:g.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(true); // pushable — but as the sibling it is, never via a rebase-onto-capped-frontier
    expect(v.verdict).toBe('undeclared-capped');
    expect(v.onto).toEqual([]);
    expect(v.undeclared).toEqual(['we:shared.txt']);

    // And once pushed, G's own frontier is capped too (its history now touches the conflict-bound cluster):
    // a later item overlapping G's files must not stack on G.
    push(plan, 'G', ['we:g.txt', 'we:shared.txt']);
    const h = planNextItem(plan, { id: 'H', files: ['we:g.txt'] });
    expect(h.stacked).toBe(false);
    expect(h.reason).toMatch(/depth-capped/);
  });
});

describe('push-time recheck (#2387 F1 — actual ⊆ declared)', () => {
  const chainPlusSibling = () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    planNextItem(plan, { id: 'E', files: ['we:e.txt'] }); // declared-disjoint sibling
    return plan;
  };

  it('clean when actual ⊆ declared', () => {
    const v = recheckAtPush(chainPlusSibling(), { id: 'E', actualFiles: ['we:e.txt'] });
    expect(v).toMatchObject({ ok: true, verdict: 'clean', undeclared: [] });
  });

  it('undeclared-disjoint when the excess overlaps no other chain (push, absorb at record)', () => {
    const v = recheckAtPush(chainPlusSibling(), { id: 'E', actualFiles: ['we:e.txt', 'we:new-file.txt'] });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('undeclared-disjoint');
    expect(v.undeclared).toEqual(['we:new-file.txt']);
  });

  it('rebase-required when the excess overlaps another chain — names the frontier tip + its acquire ref', () => {
    const v = recheckAtPush(chainPlusSibling(), { id: 'E', actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('rebase-required');
    expect(v.undeclared).toEqual(['we:shared.txt']);
    expect(v.onto).toEqual(['A']);
    expect(v.ontoTips.A).toEqual({ we: { sha: 'sha-A', ref: 'lane/x-A' } });
  });

  it('apply-rebase repairs the plan so the re-run recheck passes and stackParents feed the manifest', () => {
    const plan = chainPlusSibling();
    const v = recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(v.ok).toBe(false);
    applyRebase(plan, { id: 'E', onto: v.onto, actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(plan.items.E.stackParents).toEqual(['A']);
    expect(plan.items.E.sibling).toBe(false);
    const again = recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:shared.txt'] });
    expect(again.ok).toBe(true);
    // And the fused chain has ONE frontier going forward.
    push(plan, 'E', ['we:e.txt', 'we:shared.txt']);
    const f = planNextItem(plan, { id: 'F', files: ['we:shared.txt'] });
    expect(f.base).toBe('E');
  });

  it('a MULTI-parent apply-rebase fuses EVERY parent chain — no stale live frontier survives', () => {
    // Two disjoint pushed chains + a sibling whose actuals bridge both.
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:a.txt'] });
    push(plan, 'A', ['we:a.txt']);
    planNextItem(plan, { id: 'B', files: ['we:b.txt'] });
    push(plan, 'B', ['we:b.txt']);
    planNextItem(plan, { id: 'E', files: ['we:e.txt'] }); // declared-disjoint sibling

    const v = recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:a.txt', 'we:b.txt'] });
    expect(v.ok).toBe(false);
    expect(new Set(v.onto)).toEqual(new Set(['A', 'B']));

    applyRebase(plan, { id: 'E', onto: v.onto, actualFiles: ['we:e.txt', 'we:a.txt', 'we:b.txt'] });
    expect(new Set(plan.items.E.stackParents)).toEqual(new Set(['A', 'B']));
    expect(recheckAtPush(plan, { id: 'E', actualFiles: ['we:e.txt', 'we:a.txt', 'we:b.txt'] }).ok).toBe(true);
    push(plan, 'E', ['we:e.txt', 'we:a.txt', 'we:b.txt']);

    // BOTH parents' chains fused into one live chain with frontier E: an item overlapping EITHER side stacks
    // on E — were A's chain left live with its stale frontier, F would stack on A's tip, a base missing E's
    // pushed a.txt edits, and the drain would hit a blind conflict on a certified-stacked lane.
    const f = planNextItem(plan, { id: 'F', files: ['we:a.txt'] });
    expect(f.stacked).toBe(true);
    expect(f.base).toBe('E');
    push(plan, 'F', ['we:a.txt']);
    const g = planNextItem(plan, { id: 'G', files: ['we:b.txt'] });
    expect(g.stacked).toBe(true);
    expect(g.base).toBe('F'); // same single fused chain, frontier advanced past E
  });

  it("an item's overlap with its OWN chain (its parents' files) is never a violation", () => {
    const plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    planNextItem(plan, { id: 'B', files: ['we:shared.txt', 'we:b.txt'] }); // stacked on A
    const v = recheckAtPush(plan, { id: 'B', actualFiles: ['we:shared.txt', 'we:b.txt'] });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('clean');
  });
});

describe('plan round-trips through JSON (the CLI persists it between seams)', () => {
  it('survives serialize/parse mid-flight with identical downstream decisions', () => {
    let plan = createStackPlan({ supported: true });
    planNextItem(plan, { id: 'A', files: ['we:shared.txt'] });
    push(plan, 'A', ['we:shared.txt']);
    plan = JSON.parse(JSON.stringify(plan));
    const b = planNextItem(plan, { id: 'B', files: ['we:shared.txt'] });
    expect(b.stacked).toBe(true);
    expect(b.base).toBe('A');
    expect(b.baseTips.we.sha).toBe('sha-A');
  });
});

describe('firstScopeOverlap — drain-transient paths never claim dispatch scope', () => {
  it.each(['.fix-evidence.md', '.fix-4965-evidence.md', '.fix-evidence-4965.md', '.lane-manifest.json'])(
    'ignores repo-root %s in old PR diffs and stale claims', (path) => {
      expect(firstScopeOverlap([`we:${path}`, 'we:a.mjs'], [`we:${path}`, 'we:b.mjs'])).toBeNull();
    },
  );

  it('still reports a real shared file after ignoring transient entries', () => {
    expect(firstScopeOverlap(
      ['we:.fix-evidence.md', 'we:scripts/x.mjs'],
      ['we:.fix-evidence.md', 'we:scripts/x.mjs'],
    )).toBe('we:scripts/x.mjs');
  });

  it('keeps nested evidence paths in scope', () => {
    expect(firstScopeOverlap(['we:docs/.fix-evidence.md'], ['we:docs/.fix-evidence.md']))
      .toBe('we:docs/.fix-evidence.md');
  });

  it('filters transient object entries on either side before directory-prefix comparisons', () => {
    const transient = { repo: 'we', path: '.fix-evidence.md' };
    const descendant = 'we:.fix-evidence.md/child';
    expect(firstScopeOverlap([transient], [descendant])).toBeNull();
    expect(firstScopeOverlap([descendant], [transient])).toBeNull();
  });

  it('preserves existing repo-root entry behavior', () => {
    expect(firstScopeOverlap(['we:'], ['we:scripts/x.mjs'])).toBeNull();
    expect(firstScopeOverlap(['we:.'], ['we:scripts/x.mjs'])).toBeNull();
    expect(firstScopeOverlap(['we:.'], ['we:.'])).toBe('we:.');
  });
});

describe('overlapsInFlight (#4295) — the shared build/fix dispatch overlap predicate', () => {
  it('does not block unrelated fixes behind PR #5038 on stale evidence scope', () => {
    expect(overlapsInFlight(
      ['we:.fix-evidence.md', 'we:a.mjs'],
      [{ id: 'fix PR #5038', scope: ['we:.fix-evidence.md', 'we:c.mjs'] }],
    )).toBeNull();
  });
  it('hits on an equal path and names the in-flight item', () => {
    expect(overlapsInFlight(['we:a/x.mjs'], [{ id: 7, scope: ['we:a/x.mjs'] }])).toEqual({ hit: 'we:a/x.mjs', with: 7 });
  });
  it('hits on a directory prefix in either direction', () => {
    expect(overlapsInFlight(['we:scripts/conveyor/x.mjs'], [{ id: 1, scope: ['we:scripts/conveyor/'] }])).toMatchObject({ with: 1 });
    expect(overlapsInFlight(['we:scripts/'], [{ id: 2, scope: ['we:scripts/conveyor/x.mjs'] }])).toMatchObject({ with: 2 });
  });
  it('does not treat a sibling name sharing a string prefix as overlap', () => {
    expect(overlapsInFlight(['we:scripts/conv'], [{ id: 1, scope: ['we:scripts/conveyor/x.mjs'] }])).toBeNull();
  });
  it('never overlaps across repos', () => {
    expect(overlapsInFlight(['plateau-app:src/a.ts'], [{ id: 1, scope: ['we:src/a.ts'] }])).toBeNull();
  });
  it('is null for empty inputs', () => {
    expect(overlapsInFlight([], [{ id: 1, scope: ['we:a'] }])).toBeNull();
    expect(overlapsInFlight(['we:a'], [])).toBeNull();
    expect(overlapsInFlight(['we:a'], [{ id: 1 }])).toBeNull();
  });
});
