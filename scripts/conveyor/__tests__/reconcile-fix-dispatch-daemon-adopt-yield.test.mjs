/** S1 interface: runTickAllRepos accepts adoptYieldProbe(). It passes a
 * shouldYield() safe-point callback to PR ticks and propagates yieldedForAdoption.
 * Once true, the signal is latched for this pass (even if the probe is one-shot).
 * prCursors and budgetRotation retain deferred work for the next pass.
 */
import { describe, it, expect, vi } from 'vitest';
import { runTickAllRepos, resolveFixPassBudgets } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';
import { runReconcileFixDispatch } from '../reconcile-fix-dispatch.mjs';

const empty = () => ({ dispatched: [], refusals: [] });
function fixture(extra = {}) {
  return { repos: ['a'], fixTick: empty, ciHealTick: async () => empty(), promoteDraftTick: empty,
    hungCiTick: () => ({ dispatch: [], refusals: [], applied: [] }),
    mainRedRebaseTick: () => ({ dispatch: [], refusals: [], applied: [] }),
    missingRunTick: () => ({ dispatch: [], refusals: [], applied: [] }),
    notesTick: () => ({ notes: [], prsByNumber: new Map() }), notesDryRun: true,
    awaitVerifyTick: async () => ({ rows: [] }), stuckFixerTick: async () => ({ rows: [] }),
    orphanGuardTick: null, authGateOverride: () => ({ paused: false, reason: null }),
    now: () => 0, prCursors: {}, budgetRotation: {},
    passBudgets: resolveFixPassBudgets({ env: {}, file: { fixPassBudget: { fixMs: 100000 } } }),
    ...extra };
}

// Exercise the real PR loop rather than reproducing its safe-point check in a fake.
function realFixTick(dispatch) {
  return options => runReconcileFixDispatch({ ...options, repo: null, root: '/repo',
    checkStaleness: () => ({ fresh: true, behind: 0 }),
    reconcile: () => ({ dispatch: [41, 42].map(prNumber => ({ kind: 'fix', prNumber,
      headRefName: `fix-branch-${prNumber}` })), refusals: [] }),
    findItemFn: () => null, loadItems: () => [], fetchItemlessDiffPaths: pr => [`src/${pr}.ts`],
    pickFreeLanes: () => [2, 9], listBuildClaims: () => [], listFixClaims: () => [],
    priorityShadow: null, tryResumeRound: null, dispatch, stepLog: () => {},
  });
}

describe('fix daemon — S1 adoption yield', () => {
  it('yields after PR 1, keeps its cursor, and resumes deferred PRs on the next tick', async () => {
    let ready = false;
    let yielded = false;
    const events = [];
    const probe = vi.fn(() => {
      if (!ready || yielded) return false;
      yielded = true;
      events.push('yield');
      return true;
    });
    const dispatch = vi.fn(entry => {
      events.push(`start:${entry.pr}`);
      ready = true; // candidate arrives during an in-flight action
      events.push(`done:${entry.pr}`);
      return { pr: entry.pr };
    });
    const cursors = {};
    const opts = fixture({ prCursors: cursors, adoptYieldProbe: probe, fixTick: realFixTick(dispatch) });
    const first = await runTickAllRepos(opts);
    expect(first.yieldedForAdoption).toBe(true);
    expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([41]);
    expect(events).toEqual(['start:41', 'done:41', 'yield']);
    expect(cursors.fix.a).toBe(42);
    dispatch.mockClear();
    const second = await runTickAllRepos(opts);
    expect(second.yieldedForAdoption).not.toBe(true);
    expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([42, 41]);
    expect(cursors.fix.a).toBeUndefined();
  });

  it('handles at least one whole PR even when the adoption probe is true before the tick', async () => {
    const dispatch = vi.fn(entry => ({ pr: entry.pr }));
    const result = await runTickAllRepos(fixture({ adoptYieldProbe: () => true,
      fixTick: realFixTick(dispatch) }));
    expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([41]);
    expect(result.yieldedForAdoption).toBe(true);
  });

  it('yields between repositories and resumes with the first untouched repo next tick', async () => {
    let ready = false;
    let latched = false;
    const adoptYieldProbe = () => {
      if (!ready || latched) return false;
      latched = true;
      return true;
    };
    const fixTick = vi.fn(() => {
      ready = true;
      return { ...empty(), handled: 1, deferred: [], nextCursor: null };
    });
    const rotation = {};
    const opts = fixture({ repos: ['a', 'b'], fixTick, adoptYieldProbe, budgetRotation: rotation });
    const first = await runTickAllRepos(opts);
    expect(first.yieldedForAdoption).toBe(true);
    expect(fixTick.mock.calls.map(([o]) => o.repo)).toEqual(['a']);
    expect(rotation.fix).toBe('b');
    fixTick.mockClear();
    await runTickAllRepos(opts);
    expect(fixTick.mock.calls.map(([o]) => o.repo)).toEqual(['b', 'a']);
  });

  it('continues normal PR processing when no adoption is ready', async () => {
    const dispatch = vi.fn(entry => ({ pr: entry.pr }));
    const result = await runTickAllRepos(fixture({ adoptYieldProbe: () => false,
      fixTick: realFixTick(dispatch) }));
    expect(dispatch.mock.calls.map(([entry]) => entry.pr)).toEqual([41, 42]);
    expect(result.yieldedForAdoption).not.toBe(true);
  });
});
