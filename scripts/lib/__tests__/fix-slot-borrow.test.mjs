import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchThrottle, resolveFixBorrowSettings } from '../dispatch-throttle.mjs';
import { createFixBorrowGate, BORROW_REASON } from '../fix-slot-borrow.mjs';
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


describe('routed Codex outcomes', () => {
  it('counts only model rows: two model misses then ten excluded rows still count 2', async () => {
    const { recordRoutedOutcome, consecutiveUnproductiveOnHead } = await import('../fix-slot-borrow.mjs');
    let table = {};
    const store = { read: () => table, write: value => { table = value; } };
    const id = { repo: 'we', pr: 7, head: 'abc', store, readClaim: () => null };
    for (let i = 0; i < 2; i++) recordRoutedOutcome({ ...id, outcome: 'no-change', cause: 'model', now: i });
    for (let i = 2; i < 22; i++) recordRoutedOutcome({ ...id, outcome: 'failed', cause: ['launcher', 'infra', 'input', 'unknown'][i % 4], now: i });
    expect(consecutiveUnproductiveOnHead(table, id)).toBe(2);
    expect(table['we#7']).toHaveLength(12);
    expect(table['we#7'].map(row => row.at)).toEqual([0, 1, ...Array.from({ length: 10 }, (_, i) => i + 12)]);
    for (let i = 22; i < 34; i++) recordRoutedOutcome({ ...id, outcome: 'no-change', cause: 'model', now: i });
    expect(table['we#7']).toHaveLength(20);
    expect(consecutiveUnproductiveOnHead(table, id)).toBe(10);
    expect(table['we#7'].map(row => row.at)).toEqual([...Array.from({ length: 10 }, (_, i) => i + 12), ...Array.from({ length: 10 }, (_, i) => i + 24)]);
  });
  it('the legacy table maps every FIX_RUN_OUTCOME', async () => {
    const { routedOutcomeCause, consecutiveUnproductiveOnHead } = await import('../fix-slot-borrow.mjs');
    const { FIX_RUN_OUTCOME, FIX_RUN_INFRA_PATTERNS } = await import('../../conveyor/fix-loop-ledger.mjs');
    const expected = { failed: 'unknown', 'no-change': 'model', 'no-change-unproven': 'model', pushed: 'unknown', 'lease-lost': 'infra' };
    expect(Object.keys(expected).sort()).toEqual(Object.values(FIX_RUN_OUTCOME).sort());
    for (const outcome of Object.values(FIX_RUN_OUTCOME)) expect(routedOutcomeCause({ outcome })).toBe(expected[outcome]);
    const reasons = ['no-finding: none', 'no-ci-failure: none', 'fix-run: refused', 'error: refused', 'missing required flag',
      'has no fix launcher', 'launch did not complete', 'lane-pool', 'Operation not permitted', 'EPERM', 'EACCES',
      'read-only file system', 'index.lock', '.git', 'sandbox', 'could not commit', 'could not push', 'could not stage',
      'conflict not resolvable', 'lane git config', 'rearm-review', 'non-fast-forward', 'fast-forward hint', 'fetch first'];
    for (const pattern of FIX_RUN_INFRA_PATTERNS) expect(reasons.some(reason => pattern.test(reason))).toBe(true);
    for (const reason of reasons) expect(routedOutcomeCause({ outcome: 'failed', reason })).toBe('launcher');
    const head = 'abc', id = { pr: 7, head };
    expect(consecutiveUnproductiveOnHead({ 'we#7': [{ head, outcome: 'no-change' }, { head, outcome: 'pushed' }] }, id)).toBe(0);
    expect(consecutiveUnproductiveOnHead({ 'we#7': [{ head, outcome: 'no-change' }, { head, outcome: 'failed' }] }, id)).toBe(1);
  });
  it('an invalid cause counts as unknown', async () => {
    const { routedOutcomeCause, consecutiveUnproductiveOnHead, recordRoutedOutcome } = await import('../fix-slot-borrow.mjs');
    for (const cause of [null, '', 'MODEL', 'typo', 1, {}]) {
      const row = { head: 'abc', outcome: 'no-change', cause };
      expect(routedOutcomeCause(row)).toBe('unknown');
      expect(consecutiveUnproductiveOnHead({ 'we#7': [row, row] }, { pr: 7, head: 'abc' })).toBe(0);
      let table = {};
      recordRoutedOutcome({ ...row, pr: 7, store: { read: () => table, write: value => { table = value; } }, readClaim: () => null });
      expect(table['we#7'][0]).toMatchObject({ cause: 'unknown', handling: 'unhandled' });
    }
  });
  it('strict routed evidence refuses corrupt files and failed durable writes', async () => {
    const { readRoutedOutcomes, recordRoutedOutcome, routedOutcomePath } = await import('../fix-slot-borrow.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'strict-routed-'));
    vi.stubEnv('WE_COORDINATION_ROOT', dir);
    try {
      const id = { repo: 'we', pr: 7, head: 'abc' }, path = routedOutcomePath(id);
      expect(readRoutedOutcomes({ ...id, strict: true })).toEqual({});
      mkdirSync(join(dir, 'fix-routed-outcomes'));
      for (const text of ['{', 'null', '[]', '{"we#7":{}}', '{"we#7":[null]}']) {
        writeFileSync(path, text);
        expect(() => readRoutedOutcomes({ ...id, strict: true })).toThrow();
        expect(() => recordRoutedOutcome({ ...id, outcome: 'failed', cause: 'unknown', readClaim: () => null })).toThrow();
      }
      rmSync(path); rmSync(join(dir, 'fix-routed-outcomes'), { recursive: true });
      writeFileSync(join(dir, 'fix-routed-outcomes'), 'blocks directory');
      expect(() => recordRoutedOutcome({ ...id, outcome: 'failed', cause: 'unknown', readClaim: () => null })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([
    ['array', []], ['empty object', {}],
    ['missing head', { at: 0, outcome: 'failed', cause: 'unknown' }],
    ...[null, 1, {}, '', ' ', ' abc '].map(head => [`invalid head ${JSON.stringify(head)}`, { at: 0, head, outcome: 'failed' }]),
    ...[undefined, null, 1, {}, '', 'typo'].map(outcome => [`invalid outcome ${JSON.stringify(outcome)}`, { at: 0, head: 'abc', outcome }]),
    ...[undefined, null, '0', -1, Infinity].map(at => [`invalid timestamp ${String(at)}`, { at, head: 'abc', outcome: 'failed' }]),
    ['invalid reason', { at: 0, head: 'abc', outcome: 'failed', reason: {} }],
    ['invalid note', { at: 0, head: 'abc', outcome: 'failed', note: [] }],
  ])('strict routed evidence rejects %s without overwriting it', async (_name, row) => {
    const { readRoutedOutcomes, recordRoutedOutcome, routedOutcomePath } = await import('../fix-slot-borrow.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'malformed-routed-'));
    vi.stubEnv('WE_COORDINATION_ROOT', dir);
    try {
      const id = { repo: 'we', pr: 7, head: 'abc' }, path = routedOutcomePath(id);
      mkdirSync(join(dir, 'fix-routed-outcomes'));
      const bytes = JSON.stringify({ 'we#7': [row] });
      writeFileSync(path, bytes);
      expect(() => readRoutedOutcomes({ ...id, strict: true })).toThrow('Invalid routed outcome ledger');
      expect(() => recordRoutedOutcome({ ...id, outcome: 'failed', readClaim: () => null })).toThrow('Invalid routed outcome ledger');
      expect(readFileSync(path, 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('strict routed evidence validates the PR key and preserves legacy rows and explicit invalid causes', async () => {
    const { readRoutedOutcomes, routedOutcomePath, consecutiveUnproductiveOnHead, unparkedUnknownOnHead } = await import('../fix-slot-borrow.mjs');
    const { FIX_RUN_OUTCOME } = await import('../../conveyor/fix-loop-ledger.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'valid-routed-'));
    vi.stubEnv('WE_COORDINATION_ROOT', dir);
    try {
      const id = { repo: 'we', pr: 7, head: 'abc' }, path = routedOutcomePath(id);
      mkdirSync(join(dir, 'fix-routed-outcomes'));
      const legacy = { at: 0, head: 'abc', outcome: 'no-change' };
      writeFileSync(path, JSON.stringify({ 'we#8': [legacy] }));
      expect(() => readRoutedOutcomes({ ...id, strict: true })).toThrow('Invalid routed outcome ledger');
      for (const outcome of Object.values(FIX_RUN_OUTCOME)) {
        const table = { 'we#7': [{ ...legacy, outcome }] };
        writeFileSync(path, JSON.stringify(table));
        expect(readRoutedOutcomes({ ...id, strict: true })).toEqual(table);
      }
      for (const cause of ['model', 'input', 'launcher', 'infra', 'unknown', null, '', 'typo', 1, {}]) {
        const table = { 'we#7': [legacy, { ...legacy, cause }] };
        writeFileSync(path, JSON.stringify(table));
        const read = readRoutedOutcomes({ ...id, strict: true });
        expect(read).toEqual(table);
        expect(consecutiveUnproductiveOnHead(read, id)).toBe(cause === 'model' ? 2 : 1);
        expect(unparkedUnknownOnHead(read, id, [])).toBe(!['model', 'input', 'launcher', 'infra'].includes(cause));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('excluded rows on another head never reset model history', async () => {
    const { consecutiveUnproductiveOnHead } = await import('../fix-slot-borrow.mjs');
    const rows = [{ head: 'abc', outcome: 'no-change', cause: 'model' },
      { head: 'old', outcome: 'failed', cause: 'launcher' }, { head: 'abc', outcome: 'no-change', cause: 'model' }];
    expect(consecutiveUnproductiveOnHead({ 'we#7': rows }, { pr: 7, head: 'abc' })).toBe(2);
  });
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
      for (let i = 0; i < 2; i++) { recordRoutedOutcome({ ...a, outcome: 'no-change' }); recordRoutedOutcome({ ...b, outcome: 'failed', cause: 'model', note: 'x' }); }
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
