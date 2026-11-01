import { describe, it, expect } from 'vitest';
import { createSharedReconcile } from '../shared-reconcile.mjs';

// A deterministic stand-in for the real planner: a pure function of the PR rows it reads plus the live claim
// table (the "state a step mutates"). Same shape as the real plan: {dispatch, refusals, notes}.
const FIXTURE = [
  { number: 1, isDraft: false, red: true },
  { number: 2, isDraft: false, red: true },
  { number: 3, isDraft: true, red: false },
  { number: 4, isDraft: false, red: false, capped: true },
];
function world() {
  const claims = new Set();
  const calls = [];
  const readPrs = () => structuredClone(FIXTURE);
  const run = ({ repo, readPrs: read = readPrs, excuseMergeGateHolds = (p) => p, enrichCodeQL = (p) => p }) => {
    const rows = enrichCodeQL(excuseMergeGateHolds(read({ repo })));
    calls.push(rows.map((r) => r.number));
    const dispatch = [];
    const refusals = [];
    const notes = [];
    for (const pr of rows) {
      if (pr.isDraft) dispatch.push({ kind: 'promote-draft', prNumber: pr.number });
      else if (pr.red && !claims.has(pr.number)) dispatch.push({ kind: pr.number === 1 ? 'fix' : 'ci-heal', prNumber: pr.number });
      else if (pr.red) refusals.push({ kind: 'claimed', prNumber: pr.number });
      if (pr.capped) notes.push({ kind: 'round-cap-exhausted', prNumber: pr.number });
    }
    return { dispatch, refusals, notes, prs: rows.length, openPrFiles: [] };
  };
  return { claims, calls, run, readPrs };
}
// The four step decisions, each only reading the plan it is given.
const decide = {
  fix: (plan) => plan.dispatch.filter((e) => e.kind === 'fix').map((e) => e.prNumber),
  ciHeal: (plan) => plan.dispatch.filter((e) => e.kind === 'ci-heal').map((e) => e.prNumber),
  promote: (plan) => plan.dispatch.filter((e) => e.kind === 'promote-draft').map((e) => e.prNumber),
  notes: (plan) => plan.notes.map((n) => n.prNumber),
};

function runOld(w) {
  const out = {};
  out.fix = decide.fix(w.run({ repo: 'r' }));
  for (const n of out.fix) w.claims.add(n);
  out.ciHeal = decide.ciHeal(w.run({ repo: 'r' }));
  for (const n of out.ciHeal) w.claims.add(n);
  out.promote = decide.promote(w.run({ repo: 'r' }));
  out.notes = decide.notes(w.run({ repo: 'r' }));
  return out;
}
function runNew(w) {
  const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
  const out = {};
  out.fix = decide.fix(s.reconcile({ repo: 'r', allowStandDownAutoProceed: true }));
  for (const n of out.fix) w.claims.add(n);
  s.invalidate('r', out.fix);
  out.ciHeal = decide.ciHeal(s.reconcile({ repo: 'r' }));
  for (const n of out.ciHeal) w.claims.add(n);
  s.invalidate('r', out.ciHeal);
  out.promote = decide.promote(s.reconcile({ repo: 'r' }));
  out.notes = s.readNotes({ repo: 'r' }).notes.map((n) => n.prNumber);
  return { out, s };
}

describe('createSharedReconcile', () => {
  it('every step decides exactly what the old per-step planner run decided (same fixtures)', () => {
    const old = runOld(world());
    const w = world();
    const { out } = runNew(w);
    expect(out).toEqual(old);
    expect(old.ciHeal).toEqual([2]); // the fix step claimed #1 first, so ci-heal sees only #2
  });

  it('runs the planner once in full; later steps only re-plan the PRs an earlier step acted on', () => {
    const w = world();
    runNew(w);
    expect(w.calls[0]).toEqual([1, 2, 3, 4]);
    expect(w.calls.slice(1)).toEqual([[1], [2]]); // refresh after fix (#1), refresh after ci-heal (#2)
    expect(w.calls.length).toBeLessThan(4);
  });

  it('without invalidation the snapshot would be stale (the test can tell)', () => {
    const w2 = world();
    const s = createSharedReconcile({ run: w2.run, readPrs: w2.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    s.reconcile({ repo: 'r' });
    w2.claims.add(2);
    expect(decide.ciHeal(s.reconcile({ repo: 'r' }))).toEqual([2]); // stale: still offers the claimed PR
    s.invalidate('r', [2]);
    expect(decide.ciHeal(s.reconcile({ repo: 'r' }))).toEqual([]); // refreshed: claim honoured
  });

  it('serves each consumer an independent copy', () => {
    const w = world();
    const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    s.reconcile({ repo: 'r' }).dispatch.length = 0;
    expect(s.reconcile({ repo: 'r' }).dispatch.length).toBeGreaterThan(0);
  });

  it('notes view returns the shared notes plus the final PR rows keyed by number', () => {
    const w = world();
    const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    const view = s.readNotes({ repo: 'r' });
    expect(view.notes).toEqual([{ kind: 'round-cap-exhausted', prNumber: 4 }]);
    expect([...view.prsByNumber.keys()]).toEqual([1, 2, 3, 4]);
  });

  it('a patch (promote-draft -> ready) is applied to the re-planned row', () => {
    const w = world();
    const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    expect(decide.promote(s.reconcile({ repo: 'r' }))).toEqual([3]);
    s.invalidate('r', [3], { isDraft: false });
    expect(decide.promote(s.reconcile({ repo: 'r' }))).toEqual([]);
    expect(s.readNotes({ repo: 'r' }).prsByNumber.get(3).isDraft).toBe(false);
  });

  it('bypasses the cache for any input beyond repo + allowStandDownAutoProceed', () => {
    const w = world();
    const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs });
    s.reconcile({ repo: 'r' });
    s.reconcile({ repo: 'r', readPrs: () => [] });
    expect(w.calls.length).toBe(2);
  });

  it('a true-flag snapshot serves a false request; a true request after a false one recomputes', () => {
    const w = world();
    const s = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    s.reconcile({ repo: 'r', allowStandDownAutoProceed: true });
    s.reconcile({ repo: 'r' });
    expect(w.calls.length).toBe(1);
    const s2 = createSharedReconcile({ run: w.run, readPrs: w.readPrs, excuseMergeGateHolds: (p) => p, enrichCodeQL: (p) => p });
    s2.reconcile({ repo: 'r' });
    s2.reconcile({ repo: 'r', allowStandDownAutoProceed: true });
    expect(w.calls.length).toBe(3);
  });

  it('never caches a deferred (non-array) read: the next step retries', () => {
    let n = 0;
    const run = ({ readPrs }) => { readPrs({ repo: 'r' }); n += 1; return { dispatch: [], refusals: [], notes: [] }; };
    const s = createSharedReconcile({ run, readPrs: () => ({ deferred: true }) });
    s.reconcile({ repo: 'r' });
    s.reconcile({ repo: 'r' });
    expect(n).toBe(2);
  });
});
