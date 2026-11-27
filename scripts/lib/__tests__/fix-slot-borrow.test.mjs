import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchThrottle, resolveFixBorrowSettings } from '../dispatch-throttle.mjs';
import { createFixBorrowGate, BORROW_REASON, consecutiveUnproductiveOnHead, recordRoutedOutcome, claudeOnlyReason } from '../fix-slot-borrow.mjs';
import { FIX_EXECUTOR_CHAIN_DEFAULT, pickChainRung } from '../fix-executor-chain.mjs';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim } from '../../conveyor/fix-dispatch-claim.mjs';
import { planBuildDispatch, BUILD_DISPATCH_POLICY } from '../../conveyor/build-dispatch-policy.mjs';
import { liveBorrowedFixInFlight } from '../../../skills-src/conveyor/build-dispatch-daemon.mjs';

// x6nuodj — these tests pin the LEGACY gate's verdicts, so the shared decision only observes here (`shadow`); the
// cut-over itself (admit() deciding) is covered in we:scripts/lib/__tests__/resource-gate.test.mjs.
beforeEach(() => { vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow'); vi.stubEnv('WE_RESOURCE_SHADOW', 'off'); });
afterEach(() => vi.unstubAllEnvs());


const claim = (kind, pr, extra = {}) => ({ owner: 'o', meta: { kind, pr, repo: 'we', ...extra } });
const memLedger = () => { let v = {}; return { read: () => v, write: (x) => { v = x; } }; };
const ON = { enabled: true, afterMinutes: 15, executor: 'claude' };
let clock;
const gateWith = (o = {}) => createFixBorrowGate({
  env: {}, settings: ON, ledger: memLedger(), now: () => clock, sample: () => ({ ok: false }), loadavg: () => 1, cpuCount: () => 12,
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
    expect(waited(gateWith({ sample: () => ({ ok: false }), loadavg: () => 36 }))).toMatchObject({ borrow: false });
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
  const full = () => createDispatchThrottle({ sample: () => ({ ok: false }), loadavg: () => 1, cpuCount: () => 12, env: {}, listClaims: () => [claim('fix', 1), claim('ci-heal', 2)] });
  const hot = () => createDispatchThrottle({ sample: () => ({ ok: false }), loadavg: () => 36, cpuCount: () => 12, env: {}, listClaims: () => [] });
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
    const loaded = gateWith({ sample: () => ({ ok: false }), loadavg: () => 36 });
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


describe('routed escalation count: model rows and total backstop', () => {
  const id = { repo: 'fixture', pr: 17, head: 'h' };
  const row = (cause, extra = {}) => ({ head: id.head, outcome: 'failed', ...(cause === undefined ? {} : { cause }), ...extra });
  const tableFor = rows => ({ 'fixture#17': rows });

  it.each([
    ['two legacy rows keep the main count', [row(), row()], 2],
    ['two launcher rows do not escalate', [row('launcher'), row('launcher')], 0],
    ['three launcher rows hit the backstop', Array.from({ length: 3 }, () => row('launcher')), 2],
    ['four launcher rows keep climbing', Array.from({ length: 4 }, () => row('launcher')), 3],
    ['one model and one input row count one', [row('model'), row('input')], 1],
    ['one model and two infra rows hit the backstop', [row('model'), row('infra'), row('infra')], 2],
    ['three model and one launcher row count three', [row('model'), row('model'), row('model'), row('launcher')], 3],
    ['two explicit model rows count two', [row('model'), row('model')], 2],
    ['an invalid cause fails toward main', [row('bogus'), row('model')], 2],
    ['a head change breaks the walk', [row('launcher', { head: 'g' }), row('model'), row('model')], 2],
    ['a push breaks the walk', [row('model'), row('model'), row('model', { outcome: 'pushed' }), row('launcher')], 0],
    ['a later different head excludes older model rows', [row('model'), row('model', { head: 'g' }), row('input')], 0],
  ])('%s', (_name, rows, expected) => {
    expect(consecutiveUnproductiveOnHead(tableFor(rows), id)).toBe(expected);
  });

  it('exports the closed non-model cause list and the three-row backstop', async () => {
    const { ROUTED_NON_MODEL_CAUSES, ROUTED_HEAD_MAX_ROWS } = await import('../fix-slot-borrow.mjs');
    expect(ROUTED_NON_MODEL_CAUSES).toEqual(['launcher', 'input', 'infra']);
    expect(Object.isFrozen(ROUTED_NON_MODEL_CAUSES)).toBe(true);
    expect(ROUTED_HEAD_MAX_ROWS).toBe(3);
  });

  it.each(['launcher', 'input', 'infra', 'model', undefined, null, '', 'bogus', 'MODEL', 1, {}, ['infra']])(
    'classifies only an explicit non-model cause: %j', async cause => {
      const { routedOutcomeCause } = await import('../fix-slot-borrow.mjs');
      expect(routedOutcomeCause?.(row(cause))).toBe(['launcher', 'input', 'infra'].includes(cause) ? cause : 'model');
    },
  );

  it('counts legacy and invalid causes without guessing from diagnostic text', () => {
    const rows = [undefined, null, '', 'bogus', 1, {}, ['infra']].map(cause => row(cause, { reason: 'no-finding: RPC failed', note: 'launcher infra input' }));
    expect(consecutiveUnproductiveOnHead(tableFor(rows), id)).toBe(rows.length);
  });

  it('bounds the backstop delay to one run for every mixture of causes', () => {
    for (let total = 3; total <= 10; total++) {
      for (let model = 0; model <= total; model++) {
        const rows = Array.from({ length: total }, (_, i) => row(i < model ? 'model' : ['launcher', 'input', 'infra'][i % 3]));
        expect(consecutiveUnproductiveOnHead(tableFor(rows), id)).toBe(Math.max(model, total - 1));
      }
    }
  });

  it('keeps the escalation threshold at two counted runs', () => {
    expect(claudeOnlyReason({ codexUnproductive: 1 })).toBeNull();
    expect(claudeOnlyReason({ codexUnproductive: 2 })).not.toBeNull();
  });

  it('launcher-only history advances monotonically to the terminal chain rung', () => {
    const indices = Array.from({ length: 8 }, (_, i) => {
      const rows = Array.from({ length: i + 1 }, () => row('launcher'));
      const decision = pickChainRung({ chain: FIX_EXECUTOR_CHAIN_DEFAULT, launcherAvailable: () => true,
        codexUnproductive: consecutiveUnproductiveOnHead(tableFor(rows), id) });
      return FIX_EXECUTOR_CHAIN_DEFAULT.indexOf(decision.rung);
    });
    expect(indices.slice(0, 2)).toEqual([0, 0]);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[FIX_EXECUTOR_CHAIN_DEFAULT.length]).toBe(FIX_EXECUTOR_CHAIN_DEFAULT.length - 1);
  });

  it.each(['launcher', 'input', 'infra', 'model', 'bogus', null, '', 1, {}, ['infra']])(
    'stores only normalized explicit causes: %j', cause => {
      const store = memLedger();
      const readClaim = vi.fn(() => null);
      recordRoutedOutcome({ ...id, cause, outcome: 'failed', reason: 'local reason', note: 'agent note',
        now: 1_700_000_000_000, store, readClaim });
      expect(store.read()['fixture#17']).toEqual([{ at: 1_700_000_000_000, head: 'h', outcome: 'failed',
        reason: 'local reason', note: 'agent note', cause: ['launcher', 'input', 'infra'].includes(cause) ? cause : 'model' }]);
      expect(readClaim.mock.calls).toEqual([['fix'], ['ci-heal']]);
    },
  );

  it('retains the exact legacy row shape when cause is omitted', () => {
    const store = memLedger();
    recordRoutedOutcome({ ...id, outcome: 'failed', now: 1_700_000_000_000, store, readClaim: () => null });
    expect(store.read()['fixture#17']).toEqual([{ at: 1_700_000_000_000, head: 'h', outcome: 'failed', reason: '', note: '' }]);
  });

  it.each(['fix', 'ci-heal'])('a borrowed %s claim still writes nothing, including cause', borrowedKind => {
    const store = { read: vi.fn(), write: vi.fn() };
    expect(recordRoutedOutcome({ ...id, outcome: 'failed', cause: 'model', now: 1_700_000_000_000, store,
      readClaim: kind => kind === borrowedKind ? { meta: { borrowed: { executor: 'codex' } } } : null })).toEqual({});
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('retains ten caused rows and clears only this PR on a push', () => {
    const store = memLedger();
    const record = { ...id, now: 1_700_000_000_000, store, readClaim: () => null };
    recordRoutedOutcome({ ...record, pr: 18, cause: 'model', outcome: 'failed' });
    for (let i = 0; i < 12; i++) recordRoutedOutcome({ ...record, cause: 'launcher', outcome: 'failed', now: record.now + i });
    expect(store.read()['fixture#17']).toHaveLength(10);
    expect(store.read()['fixture#17'][0].at).toBe(record.now + 2);
    expect(consecutiveUnproductiveOnHead(store.read(), id)).toBe(9);
    recordRoutedOutcome({ ...record, cause: 'model', outcome: 'pushed' });
    expect(store.read()).not.toHaveProperty('fixture#17');
    expect(store.read()['fixture#18']).toHaveLength(1);
  });
});

describe('routed Codex outcomes', () => {
  it('bounds history, counts only trailing failures on the head, clears on push, and routes fallback', async () => {
    const { recordRoutedOutcome, consecutiveUnproductiveOnHead, chooseFixExecutor, claudeOnlyReason } = await import('../fix-slot-borrow.mjs');
    let table = {};
    const store = { read: () => table, write: t => { table = t; } };
    const id = { repo: 'we', pr: 7, head: 'abc', readClaim: () => null };
    for (let i = 0; i < 12; i++) recordRoutedOutcome({ ...id, outcome: 'no-change', reason: 'empty', store });
    expect(table['we#7']).toHaveLength(10);
    expect(consecutiveUnproductiveOnHead(table, id)).toBe(10);
    expect(consecutiveUnproductiveOnHead(table, { ...id, head: 'new' })).toBe(0);
    expect(claudeOnlyReason({ codexUnproductive: 1 })).toBeNull();
    expect(claudeOnlyReason({ codexUnproductive: 2 })).toContain('2 unproductive runs) → falls back to Claude');
    expect(chooseFixExecutor({ launcherAvailable: true, codexUnproductive: 2 }).executor).toBe('claude');
    expect(chooseFixExecutor({ launcherAvailable: true, codexUnproductive: 0 }).executor).toBe('codex');
    recordRoutedOutcome({ ...id, outcome: 'pushed', store });
    expect(table).toEqual({});
    recordRoutedOutcome({ ...id, outcome: 'failed', store, readClaim: () => ({ meta: { borrowed: { executor: 'codex' } } }) });
    expect(table).toEqual({});
  });
  it('counts only the trailing run on the current head (an interleaved head resets the count)', async () => {
    const { consecutiveUnproductiveOnHead } = await import('../fix-slot-borrow.mjs');
    const id = { repo: 'we', pr: 7, head: 'abc' };
    const at = (...heads) => ({ 'we#7': heads.map(head => ({ head, outcome: 'no-change' })) });
    expect(consecutiveUnproductiveOnHead(at('abc', 'abc', 'old', 'abc'), id)).toBe(1);
    expect(consecutiveUnproductiveOnHead(at('abc', 'abc', 'old'), id)).toBe(0);
    expect(consecutiveUnproductiveOnHead({ 'we#7': [{ head: 'abc', outcome: 'failed' }, { head: 'abc', outcome: 'pushed' }] }, id)).toBe(0);
    expect(consecutiveUnproductiveOnHead(at('abc', 'abc'), { ...id, repo: 'fui' })).toBe(0);
  });
  it('keeps one atomically-written ledger file per PR, so interleaved writers for different PRs never clobber each other', async () => {
    const { recordRoutedOutcome, readRoutedOutcomes, consecutiveUnproductiveOnHead } = await import('../fix-slot-borrow.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'routed-outcomes-'));
    vi.stubEnv('WE_COORDINATION_ROOT', dir);
    try {
      const a = { repo: 'we', pr: 1, head: 'h1', readClaim: () => null };
      const b = { repo: 'fui', pr: 2, head: 'h2', readClaim: () => null };
      for (let i = 0; i < 2; i++) { recordRoutedOutcome({ ...a, outcome: 'no-change' }); recordRoutedOutcome({ ...b, outcome: 'failed', note: 'x' }); }
      expect(consecutiveUnproductiveOnHead(readRoutedOutcomes(a), a)).toBe(2);
      expect(consecutiveUnproductiveOnHead(readRoutedOutcomes(b), b)).toBe(2);
      expect(readRoutedOutcomes(b)['fui#2'][0]).toMatchObject({ note: 'x' });
      expect(readRoutedOutcomes({ repo: 'we', pr: 2 })).toEqual({});
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('mergeOntoFor: restack base first, then the conflict base, else the @pr-base sentinel (never a guessed main); no merge otherwise', async () => {
    const { mergeOntoFor } = await import('../fix-slot-borrow.mjs');
    expect(mergeOntoFor({ restack: { onto: 'lane/b' }, isConflict: true, baseRefName: 'dev' })).toBe('lane/b');
    expect(mergeOntoFor({ isConflict: true, baseRefName: 'dev' })).toBe('dev');
    expect(mergeOntoFor({ isConflict: true })).toBe('@pr-base');
    expect(mergeOntoFor({ isConflict: true, baseRefName: '' })).toBe('@pr-base');
    expect(mergeOntoFor({})).toBeNull();
  });
});
