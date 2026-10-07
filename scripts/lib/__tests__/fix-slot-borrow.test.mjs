import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchThrottle, resolveFixBorrowSettings } from '../dispatch-throttle.mjs';
import { createFixBorrowGate, BORROW_REASON } from '../fix-slot-borrow.mjs';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim } from '../../conveyor/fix-dispatch-claim.mjs';
import { planBuildDispatch, BUILD_DISPATCH_POLICY } from '../../conveyor/build-dispatch-policy.mjs';
import { liveBorrowedFixInFlight } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';

const claim = (kind, pr, extra = {}) => ({ owner: 'o', meta: { kind, pr, repo: 'we', ...extra } });
const memLedger = () => { let v = {}; return { read: () => v, write: (x) => { v = x; } }; };
const ON = { enabled: true, afterMinutes: 15, executor: 'claude' };
let clock;
const gateWith = (o = {}) => createFixBorrowGate({
  env: {}, settings: ON, ledger: memLedger(), now: () => clock, loadavg: () => 1, cpuCount: () => 12,
  caps: { claude: 1, external: 4 }, ...o,
});
const MIN = 60_000;

describe('fixDispatch borrow settings', () => {
  it('product default is OFF / 15 min / codex; the file and env override; junk never turns it on', () => {
    expect(resolveFixBorrowSettings({ env: {}, file: {} })).toEqual({ enabled: false, afterMinutes: 15, executor: 'codex' });
    const file = { fixDispatch: { borrowBuildSlots: 'on', borrowAfterMinutes: 5, borrowExecutor: 'agy-claude' } };
    expect(resolveFixBorrowSettings({ env: {}, file })).toEqual({ enabled: true, afterMinutes: 5, executor: 'agy-claude' });
    expect(resolveFixBorrowSettings({ env: { WE_FIX_BORROW_BUILD_SLOTS: 'off', WE_FIX_BORROW_EXECUTOR: 'claude' }, file })).toMatchObject({ enabled: false, executor: 'claude' });
    expect(resolveFixBorrowSettings({ env: { WE_FIX_BORROW_BUILD_SLOTS: 'maybe' }, file: {} }).enabled).toBe(false);
  });
});

describe('createFixBorrowGate', () => {
  it('borrows only once the fix has waited borrowAfterMinutes on the cap', () => {
    clock = 1_000_000;
    const g = gateWith();
    expect(g.consider({ pr: 7 })).toMatchObject({ borrow: false });
    clock += 14 * MIN;
    expect(g.consider({ pr: 7 }).borrow).toBe(false);
    clock += 1 * MIN;
    expect(g.consider({ pr: 7 })).toMatchObject({ borrow: true, executor: 'claude', reason: BORROW_REASON, waitedMinutes: 15 });
  });
  it('a gap with no cap deferral restarts the wait; clear() forgets it', () => {
    clock = 1_000_000;
    const g = gateWith();
    g.consider({ pr: 7 });
    clock += 40 * MIN;
    expect(g.consider({ pr: 7 }).borrow).toBe(false);
    clock += 15 * MIN;
    g.clear({ pr: 7 });
    expect(g.consider({ pr: 7 }).borrow).toBe(false);
  });
  it('is off by default', () => {
    clock = 0;
    expect(gateWith({ settings: { ...ON, enabled: false } }).consider({ pr: 1 })).toEqual({ borrow: false, why: 'borrow-off' });
  });
  const waited = (g) => { g.consider({ pr: 7 }); clock += 16 * MIN; return g.consider({ pr: 7 }); };
  it('does not borrow when the host is loaded', () => {
    clock = 1_000_000;
    expect(waited(gateWith({ loadavg: () => 36 }))).toMatchObject({ borrow: false });
  });
  it('does not borrow when the builder has no free slot (a build is running) and never takes a taken one', () => {
    clock = 1_000_000;
    expect(waited(gateWith({ listBuildClaims: () => [{ meta: { num: '5', kind: 'build' } }] })).why).toMatch(/no free claude builder slot/);
    clock = 1_000_000;
    const g = gateWith({ settings: { ...ON, executor: 'codex' }, launcherAvailable: () => true, caps: { claude: 1, external: 1 } });
    g.consider({ pr: 1 }); g.consider({ pr: 2 }); clock += 16 * MIN;
    expect(g.consider({ pr: 1 }).borrow).toBe(true);
    expect(g.consider({ pr: 2 }).borrow).toBe(false); // the one external slot is now taken
  });
  it('counts live borrowed fixes against the slot', () => {
    clock = 1_000_000;
    const g = gateWith({ listFixClaims: () => [claim('fix', 3, { borrowed: { executor: 'claude' } })] });
    expect(waited(g).borrow).toBe(false);
  });
  it('does not borrow with no launcher for the executor', () => {
    clock = 1_000_000;
    expect(waited(gateWith({ settings: { ...ON, executor: 'codex' } })).why).toMatch(/no codex fix launcher/);
  });
});

describe('runReconcileFixDispatch borrows a builder slot', () => {
  const full = () => createDispatchThrottle({ loadavg: () => 1, cpuCount: () => 12, env: {}, listClaims: () => [claim('fix', 1), claim('ci-heal', 2)] });
  const hot = () => createDispatchThrottle({ loadavg: () => 36, cpuCount: () => 12, env: {}, listClaims: () => [] });
  const run = (o) => runReconcileFixDispatch({
    root: '/repo', dispatch: vi.fn((e) => ({ pr: e.pr, lane: e.lane })), tryResume: () => ({ resumed: false, resumeAttempt: null }),
    reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 7, headRefName: 'lane/7-x' }], refusals: [] }),
    findItemFn: () => ({ num: '7', slug: 'x', specPath: 'backlog/7-x.md', scope: ['we:a.mjs'] }),
    loadItems: () => [], pickFreeLanes: () => [2], checkStaleness: () => ({ fresh: true, behind: 0 }),
    fetchItemlessDiffPaths: () => [], listBuildClaims: () => [], listFixClaims: () => [], ...o,
  });
  const readyGate = () => { clock = 1_000_000; const g = gateWith(); g.consider({ repo: 'we', pr: 7 }); clock += 16 * MIN; return g; };

  it('cap full + free builder slot + waited >= 15 min -> dispatched as borrowed-build-slot', () => {
    const dispatch = vi.fn((e) => ({ pr: e.pr, lane: e.lane }));
    const r = run({ dispatchThrottle: full(), borrowGate: readyGate(), dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1].borrowed).toEqual({ executor: 'claude', reason: BORROW_REASON });
    expect(r.dispatched[0]).toMatchObject({ pr: 7, reason: BORROW_REASON, borrowed: { executor: 'claude' } });
  });
  it('the same cap-full case with the gate absent (product default) still waits', () => {
    const dispatch = vi.fn();
    const r = run({ dispatchThrottle: full(), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.refusals).toContainEqual(expect.objectContaining({ pr: 7, kind: 'fix-cap' }));
  });
  it('cap full but waited < 15 min -> not borrowed, refusal names why', () => {
    clock = 1_000_000;
    const dispatch = vi.fn();
    const r = run({ dispatchThrottle: full(), borrowGate: gateWith(), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.refusals[0].why).toMatch(/not borrowing a builder slot: waited/);
  });
  it('a scope-overlap wait is NOT borrowed (the planner refuses it before the cap is asked)', () => {
    const dispatch = vi.fn();
    const gate = readyGate();
    const spy = vi.spyOn(gate, 'consider');
    const r = run({
      dispatchThrottle: full(), borrowGate: gate, dispatch,
      fetchItemlessDiffPaths: () => ['a.mjs'],
      listFixClaims: () => [claim('fix', 99, { scope: ['we:a.mjs'] })],
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(r.refusals).toContainEqual(expect.objectContaining({ pr: 7, kind: 'scope-overlap' }));
  });
  it('high host load is NOT borrowed past', () => {
    const dispatch = vi.fn();
    const gate = readyGate();
    const r = run({ dispatchThrottle: hot(), borrowGate: gate, dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.refusals).toContainEqual(expect.objectContaining({ pr: 7, kind: 'host-load' }));
    // and the cap-full case under load: the gate itself refuses on load
    const loaded = gateWith({ loadavg: () => 36 });
    clock = 1_000_000; loaded.consider({ repo: 'we', pr: 7 }); clock += 16 * MIN;
    const d2 = vi.fn();
    run({ dispatchThrottle: full(), borrowGate: loaded, dispatch: d2 });
    expect(d2).not.toHaveBeenCalled();
  });
});

describe('a borrowed fix is a normal claim that the build daemon counts', () => {
  it('records the borrowed slot on the claim, and releases like any claim', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'borrow-claim-'));
    try {
      const c = acquireFixDispatchClaim({ repo: 'we', pr: 7, scope: ['we:a.mjs'], borrowed: { executor: 'codex' }, owner: 'o', lockRoot });
      expect(c.ok).toBe(true);
      const plain = acquireFixDispatchClaim({ repo: 'we', pr: 8, owner: 'o', lockRoot });
      expect(plain.ok).toBe(true);
      expect(releaseFixDispatchClaim({ repo: 'we', pr: 7, kind: 'fix', owner: 'o', lockRoot }).released).toBe(true);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });
  it('liveBorrowedFixInFlight lists only borrowed fixes, as external/claude builder rows', () => {
    const rows = liveBorrowedFixInFlight(() => [
      claim('fix', 7, { scope: ['we:a.mjs'], borrowed: { executor: 'codex' } }),
      claim('fix', 8, { borrowed: { executor: 'claude' } }),
      claim('fix', 9, {}),
    ]);
    expect(rows.map((r) => [r.num, r.executor, r.borrowedFix])).toEqual([['fix-7', 'codex', true], ['fix-8', 'claude', true]]);
  });
  it('a borrowed fix takes the builder slot: the planner holds a build for that class, and it is not an open item', () => {
    const policy = { ...BUILD_DISPATCH_POLICY, maxConcurrentBuilds: 1, maxConcurrentExternalBuilds: 1 };
    const cand = [{ num: '50', scope: ['we:z.mjs'], executor: 'claude' }];
    const base = { candidates: cand, openPrs: [], policy };
    const free = planBuildDispatch({ ...base, inFlight: [] });
    expect(free.dispatch.map((d) => d.num)).toEqual(['50']);
    const rows = liveBorrowedFixInFlight(() => [claim('fix', 8, { scope: ['we:y.mjs'], borrowed: { executor: 'claude' } })]);
    const busy = planBuildDispatch({ ...base, inFlight: rows });
    expect(busy.dispatch).toEqual([]);
    expect(busy.hold[0]).toMatchObject({ num: '50', rule: 'cap' });
    expect(busy.openItems.nums).not.toContain('fix-8');
  });
});
