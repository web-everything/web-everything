/**
 * @file dispatch-lane-permission-grant.test.mjs — #xrv69j6 (epic #4075).
 *
 * WHY THIS FILE EXISTS. Since #4174/#2701 a dispatched session's cwd is a scratch directory outside every
 * checkout, and its brief's very first real step (`lane-pool.mjs acquire`, then an Edit/Write into the lane
 * it just leased) targets a directory the CLI has never granted — an unattended `--bg` session hits an
 * unanswerable permission prompt and sits blocked forever (live case: `fix-2735`, 36+ min blocked, #2735
 * stalled). `dispatch-lane.mjs`'s own `assigned-lane` guard means a lane NUMBER is always known by the time
 * `createDispatchSinks`'s effect payload is built, so `{@link laneDirFor}`/`{@link dispatchLaneGrant}` resolve
 * that number to an absolute directory and the sink grants it, in `<sessionCwd>/.claude/settings.local.json`,
 * BEFORE the agent is spawned into that cwd.
 *
 * NO REAL FS, NO REAL PROCESS. `laneDirFor`/`laneRootsFor`/`dispatchLaneGrant` are pure over an injected
 * `exists`; the sink test below injects `grantLanePermission`/`resolveLaneGrant` directly (mirrors
 * `dispatch-lane-defaults.test.mjs`'s own `spyExec` seam for the OTHER subprocess calls this file makes) so
 * this never touches a real `.claude/settings.local.json` or spawns a real `claude`.
 */
import { describe, it, expect } from 'vitest';

import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { createDispatchSinks, laneDirFor, laneRootsFor, dispatchLaneGrant } from '../dispatch-lane-io.mjs';

const ROOT = '/Users/op/workspace/webeverything';
const existsOnly = (paths) => (p) => paths.includes(p);

describe('laneDirFor — the ONE lane a dispatch will use, resolved to its absolute path', () => {
  it('prefers whichever pool-dir basename actually exists on this host', () => {
    const dir = laneDirFor(40, {
      root: ROOT,
      exists: existsOnly(['/Users/op/workspace/.lanes/web-everything/lane-40']),
    });
    expect(dir).toBe('/Users/op/workspace/.lanes/web-everything/lane-40');
  });

  it('falls back to the first candidate when neither pool-dir basename exists yet (never refuses)', () => {
    const dir = laneDirFor(7, { root: ROOT, exists: () => false });
    expect(dir).toBe('/Users/op/workspace/.lanes/web-everything/lane-7');
  });

  it('never resolves inside a PRIMARY checkout — always under .lanes/', () => {
    const dir = laneDirFor(1, { root: ROOT, exists: () => false });
    expect(dir).toMatch(/\/\.lanes\//);
    expect(dir).not.toContain('/webeverything/lane-');
  });
});

describe('laneRootsFor — the defensive fallback surface (should not be reachable in practice)', () => {
  it('returns only the pool roots that actually exist', () => {
    const roots = laneRootsFor(ROOT, existsOnly(['/Users/op/workspace/.lanes/web-everything']));
    expect(roots).toEqual(['/Users/op/workspace/.lanes/web-everything']);
  });

  it('returns nothing (never a primary) when no pool root exists', () => {
    expect(laneRootsFor(ROOT, () => false)).toEqual([]);
  });
});

describe('dispatchLaneGrant — the grant for one dispatch payload', () => {
  it('given a lane number, grants exactly that ONE lane — additionalDirectories + matching Edit/Write allow rules', () => {
    const grant = dispatchLaneGrant({ lane: 40 }, { root: ROOT, exists: () => false });
    expect(grant.additionalDirectories).toEqual(['/Users/op/workspace/.lanes/web-everything/lane-40']);
    expect(grant.allow).toEqual([
      'Edit(/Users/op/workspace/.lanes/web-everything/lane-40/**)',
      'Write(/Users/op/workspace/.lanes/web-everything/lane-40/**)',
    ]);
  });

  it('given NO lane number (defensive-only path), falls back to every existing lanes-pool root, never a primary', () => {
    const grant = dispatchLaneGrant({ lane: null }, {
      root: ROOT, exists: existsOnly(['/Users/op/workspace/.lanes/web-everything']),
    });
    expect(grant.additionalDirectories).toEqual(['/Users/op/workspace/.lanes/web-everything']);
    expect(grant.allow).toEqual([
      'Edit(/Users/op/workspace/.lanes/web-everything/**)',
      'Write(/Users/op/workspace/.lanes/web-everything/**)',
    ]);
  });

  it('an empty-string lane is treated the same as no lane (defensive path), not as a literal lane "" ', () => {
    const grant = dispatchLaneGrant({ lane: '' }, { root: ROOT, exists: () => false });
    expect(grant.additionalDirectories).toEqual([]);
  });

  // xftsbsg (epic #3383) — LIVE-CONFIRMED defect: every constellation repo's lane pool numbers its own lanes
  // from 1, so `.lanes/web-everything/lane-1`, `.lanes/frontierui/lane-1` and `.lanes/plateau-app/lane-1` all
  // exist on a real host AT THE SAME TIME. Before this fix, `dispatchLaneGrant` always probed WE's own pool
  // dirs regardless of which repo the dispatch was actually for, so a frontierui/plateau-app build's pre-spawn
  // grant resolved to WE's own unrelated same-numbered lane whenever it happened to exist too.
  it('reads the repo off payload.scope and grants that repo\'s OWN lane, not WE\'s same-numbered one', () => {
    const grant = dispatchLaneGrant(
      { lane: 1, scope: ['plateau-app:src/feature-tracker/feature-tracking.mount-conformance.test.ts'] },
      {
        root: ROOT,
        // BOTH pools have a lane-1 — the exact live collision this test proves is resolved correctly.
        exists: existsOnly([
          '/Users/op/workspace/.lanes/web-everything/lane-1',
          '/Users/op/workspace/.lanes/plateau-app/lane-1',
        ]),
      },
    );
    expect(grant.additionalDirectories).toEqual(['/Users/op/workspace/.lanes/plateau-app/lane-1']);
    expect(grant.allow).toEqual([
      'Edit(/Users/op/workspace/.lanes/plateau-app/lane-1/**)',
      'Write(/Users/op/workspace/.lanes/plateau-app/lane-1/**)',
    ]);
  });

  it('resolves frontierui scope to frontierui\'s own pool dir the same way', () => {
    const grant = dispatchLaneGrant(
      { lane: 3, scope: ['frontierui:plugs/webdirectives/ssr/net/for-each.mjs'] },
      { root: ROOT, exists: existsOnly(['/Users/op/workspace/.lanes/frontierui/lane-3']) },
    );
    expect(grant.additionalDirectories).toEqual(['/Users/op/workspace/.lanes/frontierui/lane-3']);
  });

  it('an empty/unrecognized scope still falls back to WE — byte-identical to pre-xftsbsg behavior', () => {
    const grant = dispatchLaneGrant(
      { lane: 40, scope: [] },
      { root: ROOT, exists: existsOnly(['/Users/op/workspace/.lanes/web-everything/lane-40']) },
    );
    expect(grant.additionalDirectories).toEqual(['/Users/op/workspace/.lanes/web-everything/lane-40']);
  });
});

describe('createDispatchSinks — grants the lane BEFORE spawning the agent', () => {
  it('calls grantLanePermission(sessionCwd, resolveLaneGrant(payload)) before the provider runs', async () => {
    const calls = [];
    const sinks = createDispatchSinks({
      root: ROOT,
      mintSessionId: () => 'sess-perm-1',
      sessionCwdFor: () => '/scratch/sess-perm-1',
      ensureSessionCwd: (d) => d,
      resolveSettingsEnv: () => ({}),
      resolveLaneGrant: (payload) => ({ additionalDirectories: [`/lanes/lane-${payload.lane}`], allow: [`Edit(/lanes/lane-${payload.lane}/**)`] }),
      grantLanePermission: (cwd, grant) => { calls.push({ step: 'grant', cwd, grant }); },
      provider: async () => { calls.push({ step: 'spawn' }); return 'sess-perm-1'; },
    });
    await sinks[DISPATCH_EFFECT]({ num: '4210', lane: 40, sessionSlug: 'fix-4210', prompt: '# go', expectedWithinMinutes: 90 });
    expect(calls.map((c) => c.step)).toEqual(['grant', 'spawn']);
    expect(calls[0].cwd).toBe('/scratch/sess-perm-1');
    expect(calls[0].grant).toEqual({ additionalDirectories: ['/lanes/lane-40'], allow: ['Edit(/lanes/lane-40/**)'] });
  });

  it('a grant that cannot land against a real (fake, unwritable) root never blocks the dispatch', async () => {
    // Uses the REAL default `grantLanePermission`/`resolveLaneGrant` (no override) against a root that cannot
    // possibly exist — the same "fake root a unit test passes" case `ensureDispatchSessionCwd`'s own docblock
    // states this module stays inert against. This asserts the SINK relies on `ensureSettingsFilePermissions`'s
    // own never-throws contract (proven directly in gh-app-shim.test.mjs) rather than wrapping the call in a
    // try/catch of its own — if the grant call is ever changed to something that CAN throw, this fails loudly
    // (the provider below would never run) instead of silently.
    const calls = [];
    const sinks = createDispatchSinks({
      root: '/primary/does-not-exist',
      mintSessionId: () => 'sess-perm-3',
      provider: async () => { calls.push('spawn'); return 'sess-perm-3'; },
    });
    await sinks[DISPATCH_EFFECT]({ num: '4210', lane: 40, sessionSlug: 'fix-4210', prompt: '# go', expectedWithinMinutes: 90 });
    expect(calls).toEqual(['spawn']);
  });
});

it('grants only the sanctioned helper for fix and ci-heal, preserving build grants', async () => {
  const { conflictHelperAllowRules } = await import('../../lib/conflict-helper-allow.mjs');
  const root = '/repo'; const options = { root, exists: () => false };
  const rules = conflictHelperAllowRules(root);
  expect(rules).toEqual(['Bash(node /repo/scripts/conveyor/resolve-conflict.mjs:*)', 'Bash(node "/repo/scripts/conveyor/resolve-conflict.mjs":*)']);
  expect(conflictHelperAllowRules(null)).toEqual([]);
  const baseline = dispatchLaneGrant({ lane: 1 }, options);
  expect(dispatchLaneGrant({ lane: 1, launchKind: 'build' }, options)).toEqual(baseline);
  for (const launchKind of ['fix', 'ci-heal']) {
    expect(dispatchLaneGrant({ lane: 1, launchKind }, options)).toEqual({ ...baseline, allow: [...baseline.allow, ...rules] });
  }
});
