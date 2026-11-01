import { describe, it, expect } from 'vitest';
import { createSharedReconcile, stepMayHaveMutated } from '../shared-reconcile.mjs';

// A deterministic stand-in for the real planner: a pure function of the live PR rows and the live claim table
// (the state a step mutates). Same plan shape as the real one: {dispatch, refusals, notes}.
const FIXTURE = [
  { number: 1, isDraft: false, red: true },
  { number: 2, isDraft: false, red: true },
  { number: 3, isDraft: true, red: false },
  { number: 4, isDraft: false, red: false, capped: true },
];
function world() {
  const claims = new Set();
  const calls = [];
  const rows = structuredClone(FIXTURE); // live PR evidence: a test may change it between planner reads
  const readPrs = () => structuredClone(rows);
  const run = ({ repo, readPrs: read = readPrs }) => {
    const seen = read({ repo });
    calls.push(seen.map((r) => r.number));
    const dispatch = [];
    const refusals = [];
    const notes = [];
    for (const pr of seen) {
      if (pr.isDraft) dispatch.push({ kind: 'promote-draft', prNumber: pr.number });
      else if (pr.red && !claims.has(pr.number)) dispatch.push({ kind: pr.number === 1 ? 'fix' : 'ci-heal', prNumber: pr.number });
      else if (pr.red) refusals.push({ kind: 'claimed', prNumber: pr.number });
      if (pr.capped) notes.push({ kind: 'round-cap-exhausted', prNumber: pr.number });
    }
    return { dispatch, refusals, notes, prs: seen.length };
  };
  return { claims, calls, run, readPrs, rows };
}
// The step decisions, each reading only the plan it is given.
const decide = {
  fix: (plan) => plan.dispatch.filter((e) => e.kind === 'fix').map((e) => e.prNumber),
  ciHeal: (plan) => plan.dispatch.filter((e) => e.kind === 'ci-heal').map((e) => e.prNumber),
  promote: (plan) => plan.dispatch.filter((e) => e.kind === 'promote-draft').map((e) => e.prNumber),
};
const make = (w) => createSharedReconcile({ run: w.run, readPrs: w.readPrs });

// OLD path: every step runs the planner itself. NEW path: fix keeps its own run; ci-heal and promote-draft share one.
function runOld(w, { ciHealMutates }) {
  const out = {};
  out.fix = decide.fix(w.run({ repo: 'we' }));
  for (const n of out.fix) w.claims.add(n);
  out.ciHeal = decide.ciHeal(w.run({ repo: 'we' }));
  for (const n of out.ciHeal) w.claims.add(n);
  if (ciHealMutates) w.rows.find((p) => p.number === 3).isDraft = false; // e.g. something promoted #3 meanwhile
  out.promote = decide.promote(w.run({ repo: 'we' }));
  return out;
}
function runNew(w, { ciHealMutates }) {
  const s = make(w);
  const out = {};
  out.fix = decide.fix(w.run({ repo: 'we' }));
  for (const n of out.fix) w.claims.add(n);
  out.ciHeal = decide.ciHeal(s.reconcile({ repo: 'we' }));
  for (const n of out.ciHeal) w.claims.add(n);
  const result = { dispatched: out.ciHeal.map((pr) => ({ repo: 'we', pr })), refusals: [] };
  if (ciHealMutates) w.rows.find((p) => p.number === 3).isDraft = false;
  if (stepMayHaveMutated(result) || ciHealMutates) s.invalidate('we');
  out.promote = decide.promote(s.reconcile({ repo: 'we' }));
  return { out, s };
}

describe('createSharedReconcile — decision equivalence with the old per-step planner run', () => {
  for (const ciHealMutates of [false, true]) {
    it(`every step decides what it decided before (same fixtures, ci-heal ${ciHealMutates ? 'mutates a PR' : 'quiet'})`, () => {
      const old = runOld(world(), { ciHealMutates });
      const { out } = runNew(world(), { ciHealMutates });
      expect(out).toEqual(old);
    });
  }

  it('serves the second consumer from the first run when nothing mutated', () => {
    const w = world();
    const s = make(w);
    s.reconcile({ repo: 'we' });
    const second = s.reconcile({ repo: 'we' });
    expect(w.calls.length).toBe(1);
    expect(decide.promote(second)).toEqual([3]);
  });

  it('an invalidated repo is re-planned in full from fresh reads (never a stale or partial plan)', () => {
    const w = world();
    const s = make(w);
    expect(decide.ciHeal(s.reconcile({ repo: 'we' }))).toEqual([2]);
    w.claims.add(2);
    w.rows.find((p) => p.number === 4).headRefOid = 'new';
    s.invalidate('we');
    expect(decide.ciHeal(s.reconcile({ repo: 'we' }))).toEqual([]);
    expect(w.calls[1]).toEqual([1, 2, 3, 4]); // every PR re-read: cross-PR context intact
  });

  it('without invalidation the snapshot would be stale (the test can tell)', () => {
    const w = world();
    const s = make(w);
    s.reconcile({ repo: 'we' });
    w.claims.add(2);
    expect(decide.ciHeal(s.reconcile({ repo: 'we' }))).toEqual([2]);
  });

  it('serves each consumer an independent copy', () => {
    const w = world();
    const s = make(w);
    s.reconcile({ repo: 'we' }).dispatch.length = 0;
    expect(s.reconcile({ repo: 'we' }).dispatch.length).toBeGreaterThan(0);
  });

  it('bypasses the cache for any input beyond repo + allowStandDownAutoProceed', () => {
    const w = world();
    const s = make(w);
    s.reconcile({ repo: 'we' });
    s.reconcile({ repo: 'we', readPrs: () => [] });
    expect(w.calls.length).toBe(2);
  });

  it('a true-flag snapshot serves a false request; a true request after a false one recomputes', () => {
    const w = world();
    const s = make(w);
    s.reconcile({ repo: 'we', allowStandDownAutoProceed: true });
    s.reconcile({ repo: 'we' });
    expect(w.calls.length).toBe(1);
    const s2 = make(w);
    s2.reconcile({ repo: 'we' });
    s2.reconcile({ repo: 'we', allowStandDownAutoProceed: true });
    expect(w.calls.length).toBe(3);
  });

  it('never caches a deferred or incomplete read: the next step retries', () => {
    let n = 0;
    const incomplete = Object.assign([{ number: 1 }], { discoveryIncomplete: true });
    for (const rows of [{ deferred: true }, incomplete]) {
      n = 0;
      const run = ({ readPrs }) => { readPrs({ repo: 'we' }); n += 1; return { dispatch: [], refusals: [], notes: [] }; };
      const s = createSharedReconcile({ run, readPrs: () => rows });
      s.reconcile({ repo: 'we' });
      s.reconcile({ repo: 'we' });
      expect(n).toBe(2);
    }
  });

  it('a planner error is not cached', () => {
    let fail = true;
    const run = ({ readPrs }) => { readPrs({ repo: 'we' }); if (fail) throw new Error('boom'); return { dispatch: [], refusals: [], notes: [] }; };
    const s = createSharedReconcile({ run, readPrs: () => [{ number: 1 }] });
    expect(() => s.reconcile({ repo: 'we' })).toThrow('boom');
    fail = false;
    expect(s.reconcile({ repo: 'we' }).dispatch).toEqual([]);
  });
});

describe('stepMayHaveMutated', () => {
  it('a dispatch, a park or a failed tick may have mutated PRs; read-only refusals may not', () => {
    expect(stepMayHaveMutated({ dispatched: [{ pr: 1 }] })).toBe(true);
    expect(stepMayHaveMutated({ refusals: [{ kind: 'fix-loop-parked' }] })).toBe(true);
    expect(stepMayHaveMutated({ refusals: [{ kind: 'tick-failed' }] })).toBe(true);
    expect(stepMayHaveMutated({ refusals: [{ kind: 'queue-cap' }, { kind: 'no-lane' }] })).toBe(false);
    expect(stepMayHaveMutated({})).toBe(false);
  });
});
