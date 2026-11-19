import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyHoldReason, planHoldRouting, holdRouteLockRoot, holdFindingsFile,
  reserveHoldRoute, releaseHoldRoute, appendHoldFinding, listHoldFindings, routeHeldItems,
  DEFAULT_ROUTE_LEASE_MINUTES,
} from '../build-dispatch-hold-router.mjs';
import { DEFAULT_BUILD_DISPATCH_HOLD_MINUTES } from '../build-dispatch-claim.mjs';

// The three LIVE reason shapes this item's own card names, verbatim from the real holds it cites (#4295,
// #4380, #4108) plus a crash reason (`wrapper-threw`) that is not a spec judgment at all.
const ALREADY_DONE_REASON = "spec already done on main: commit b93d13e29 (fix(review-pr): judgeAdvisory "
  + 'quota-holds/degrades instead of crashing the run, #x5s8b47) lands both MVP parts - card just needs resolving.';
const NOT_BUILDABLE_REASON = 'spec not buildable as written within declared scope: the enforcement call '
  + 'sites are all OUTSIDE scope. Needs re-shaping.';
const SUPERSEDED_REASON = 'spec superseded by #gh-graphql-budget + #no-label-search already on main: the '
  + 'context listing is now served from the host-shared TTL open-PR snapshot. Re-scope or close.';

describe('classifyHoldReason — the three routes', () => {
  it('already-done: extracts the cited commit sha', () => {
    expect(classifyHoldReason(ALREADY_DONE_REASON)).toEqual({ route: 'already-done', commit: 'b93d13e29' });
  });

  it('out-of-scope: "spec not buildable"', () => {
    expect(classifyHoldReason(NOT_BUILDABLE_REASON)).toEqual({ route: 'out-of-scope', commit: null });
  });

  it('out-of-scope: "spec superseded"', () => {
    expect(classifyHoldReason(SUPERSEDED_REASON)).toEqual({ route: 'out-of-scope', commit: null });
  });

  it("other: a crash reason that is not a spec judgment at all (e.g. 'wrapper-threw')", () => {
    expect(classifyHoldReason('wrapper-threw')).toEqual({ route: 'other', commit: null });
  });

  it('other: null/undefined/empty reason never throws', () => {
    expect(classifyHoldReason(null)).toEqual({ route: 'other', commit: null });
    expect(classifyHoldReason(undefined)).toEqual({ route: 'other', commit: null });
    expect(classifyHoldReason('')).toEqual({ route: 'other', commit: null });
  });
});

describe('planHoldRouting', () => {
  it('maps every hold (listBuildDispatchHolds\' own normalized {num,reason} shape) to a routing entry, in order', () => {
    const holds = [
      { num: '4295', reason: NOT_BUILDABLE_REASON },
      { num: '4380', reason: ALREADY_DONE_REASON },
      { num: '4108', reason: SUPERSEDED_REASON },
      { num: 'x0e7udq', reason: 'wrapper-threw' },
    ];
    expect(planHoldRouting(holds)).toEqual([
      { num: '4295', route: 'out-of-scope', commit: null, reason: NOT_BUILDABLE_REASON },
      { num: '4380', route: 'already-done', commit: 'b93d13e29', reason: ALREADY_DONE_REASON },
      { num: '4108', route: 'out-of-scope', commit: null, reason: SUPERSEDED_REASON },
      { num: 'x0e7udq', route: 'other', commit: null, reason: 'wrapper-threw' },
    ]);
  });

  it('drops a hold with no `num` rather than routing it blind, and tolerates a non-array input', () => {
    expect(planHoldRouting([{ reason: 'x' }, null, { num: '4380', reason: ALREADY_DONE_REASON }]))
      .toEqual([{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: ALREADY_DONE_REASON }]);
    expect(planHoldRouting(null)).toEqual([]);
    expect(planHoldRouting(undefined)).toEqual([]);
  });

  // PR #2967 review (security) — `num` becomes a lock dir, a git ref and a log filename downstream.
  it('drops a hold whose `num` is not a card id (traversal, slash, shell metachar, oversized hash)', () => {
    const holds = ['../../x', 'a/b', '4380;rm', 'x'.repeat(40), '..'].map((num) => ({ num, reason: ALREADY_DONE_REASON }));
    expect(planHoldRouting([...holds, { num: 'x5s8b47', reason: 'wrapper-threw' }]))
      .toEqual([{ num: 'x5s8b47', route: 'other', commit: null, reason: 'wrapper-threw' }]);
  });
});

describe('reserveHoldRoute / releaseHoldRoute — the cross-tick dedup lease', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'hold-route-lease-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

  it('the first reserve for an item succeeds; a second, concurrent reserve for the SAME item is refused '
    + '(a landing attempt already in flight)', () => {
    const first = reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot, owner: 'host:111' });
    expect(first.ok).toBe(true);
    const second = reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot, owner: 'host:222' });
    expect(second.ok).toBe(false);
  });

  it('releasing frees the item for a fresh reserve', () => {
    reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot, owner: 'host:111' });
    expect(releaseHoldRoute({ num: '4380', route: 'already-done', lockRoot }).released).toBe(true);
    expect(reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot, owner: 'host:222' }).ok).toBe(true);
  });

  it('releasing an absent lease is a no-op, never an error', () => {
    expect(releaseHoldRoute({ num: 'never-reserved', route: 'already-done', lockRoot })).toEqual({ released: false, reason: 'absent' });
  });

  // #4465 review round 2 (live correctness finding) — the resident daemon is ONE long-lived process, so every
  // tick's reserve call used to share a CONSTANT `owner` (`hostname:pid`). `file-locks.mjs#reclaimDecision`
  // treats a same-owner re-reserve as a reentrant renewal (`ok:true`, not a refusal) — so a fixed owner made
  // EVERY tick's reserve succeed, spawning a fresh overlapping landing attempt each time. This is the
  // regression test for that exact bug: two calls with the DEFAULT owner (no explicit `owner` override, the
  // production shape) must behave exactly like two calls from two DIFFERENT owners — first wins, second is
  // refused — never both `ok:true`.
  it('two reserves with the DEFAULT owner (the production shape — no explicit owner override) still dedup: '
    + 'the second is refused, not treated as a same-owner renewal', () => {
    const first = reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot });
    expect(first.ok).toBe(true);
    const second = reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot });
    expect(second.ok).toBe(false);
  });

  it('the resource key includes the route, so two DIFFERENT routes for the same num never collide', () => {
    const a = reserveHoldRoute({ num: '4380', route: 'already-done', lockRoot, owner: 'host:1' });
    const b = reserveHoldRoute({ num: '4380', route: 'other', lockRoot, owner: 'host:2' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });
});

describe('appendHoldFinding / listHoldFindings — the route-(c) ledger', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hold-findings-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('starts a fresh ledger when none exists yet, and appends across calls', () => {
    const file = join(root, 'build-dispatch-hold-findings.json');
    appendHoldFinding({ num: 'x0e7udq', reason: 'wrapper-threw', now: new Date('2026-09-29T12:00:00Z'), file });
    appendHoldFinding({ num: '4359', reason: 'wrapper-threw', now: new Date('2026-09-29T13:00:00Z'), file });
    const findings = listHoldFindings({ file });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual({ num: 'x0e7udq', reason: 'wrapper-threw', recordedAt: '2026-09-29T12:00:00.000Z' });
    expect(existsSync(file)).toBe(true);
  });

  it('a corrupt ledger file is recovered as a fresh one rather than throwing', () => {
    const file = join(root, 'corrupt.json');
    writeFileSync(file, 'not json');
    appendHoldFinding({ num: '4108', reason: 'x', file });
    expect(listHoldFindings({ file })).toHaveLength(1);
  });

  it('listHoldFindings on a missing file returns [], never throws', () => {
    expect(listHoldFindings({ file: join(root, 'nope.json') })).toEqual([]);
  });
});

describe('routeHeldItems — the IO-shell orchestrator, every effect injected, async', () => {
  it("route 'other': dedups via reserveRoute FIRST, then records a finding, and does NOT release the "
    + 'build-dispatch hold — the hold is the cooldown that stops instant re-dispatch into the same crash; it '
    + 'is left to self-expire on its own TTL', async () => {
    const findings = [];
    const reserved = [];
    const outcomes = await routeHeldItems({
      plan: [{ num: 'x0e7udq', route: 'other', commit: null, reason: 'wrapper-threw' }],
      recordFinding: (a) => findings.push(a),
      reserveRoute: (a) => { reserved.push(a); return { ok: true }; },
      spawnLand: () => { throw new Error('must not be called for route other'); },
    });
    expect(reserved).toEqual([{ num: 'x0e7udq', route: 'other' }]);
    expect(findings).toEqual([{ num: 'x0e7udq', reason: 'wrapper-threw' }]);
    expect(outcomes).toEqual([{ num: 'x0e7udq', route: 'other', action: 'finding-recorded' }]);
  });

  // #4465 review round 2 (live correctness finding) — an earlier revision never dedup'd route 'other' at
  // all, so the SAME held item re-planned every ~2-minute tick for its whole 240-minute hold TTL would append
  // roughly 120 duplicate ledger entries for one single crash. `reserveRoute`'s own lease now gates this
  // route exactly like (a)/(b).
  it("route 'other' is dedup'd across calls exactly like (a)/(b): a second call while the lease is still "
    + 'held records no second finding', async () => {
    const findings = [];
    let reserveCalls = 0;
    const reserveRoute = () => { reserveCalls += 1; return reserveCalls === 1 ? { ok: true } : { ok: false, reason: 'held' }; };
    const plan = [{ num: 'x0e7udq', route: 'other', commit: null, reason: 'wrapper-threw' }];
    const first = await routeHeldItems({ plan, recordFinding: (a) => findings.push(a), reserveRoute, spawnLand: () => {} });
    const second = await routeHeldItems({ plan, recordFinding: (a) => findings.push(a), reserveRoute, spawnLand: () => {} });
    expect(findings).toHaveLength(1);
    expect(first).toEqual([{ num: 'x0e7udq', route: 'other', action: 'finding-recorded' }]);
    expect(second).toEqual([{ num: 'x0e7udq', route: 'other', action: 'already-in-flight' }]);
  });

  it("route 'already-done'/'out-of-scope': reserves a dedup lease then spawns the landing pass", async () => {
    const spawned = [];
    const outcomes = await routeHeldItems({
      plan: [
        { num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'x' },
        { num: '4295', route: 'out-of-scope', commit: null, reason: 'y' },
      ],
      reserveRoute: ({ num }) => ({ ok: true, resource: num }),
      spawnLand: (entry) => { spawned.push(entry.num); },
    });
    expect(spawned).toEqual(['4380', '4295']);
    expect(outcomes).toEqual([
      { num: '4380', route: 'already-done', action: 'landing-spawned' },
      { num: '4295', route: 'out-of-scope', action: 'landing-spawned' },
    ]);
  });

  it('an item whose dedup lease is already held (a prior tick\'s landing is still in flight, or a landed PR '
    + 'has not yet merged) is skipped, never spawned twice', async () => {
    const spawned = [];
    const outcomes = await routeHeldItems({
      plan: [{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'x' }],
      reserveRoute: () => ({ ok: false, reason: 'held' }),
      spawnLand: (entry) => { spawned.push(entry.num); },
    });
    expect(spawned).toEqual([]);
    expect(outcomes).toEqual([{ num: '4380', route: 'already-done', action: 'already-in-flight' }]);
  });

  it.each(['already-done', 'out-of-scope'])('%s: a refused spawn releases the real lease for the next tick; a true spawn keeps it', async route => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'hold-route-refused-'));
    const entry = { num: '4380', route };
    const reserveRoute = args => reserveHoldRoute({ ...args, lockRoot });
    const releaseRoute = args => releaseHoldRoute({ ...args, lockRoot });
    const run = result => routeHeldItems({ plan: [entry], reserveRoute, releaseRoute,
      readSettings: () => ({}), spawnLand: async () => result });
    try {
      for (const [reason, expected] of [['runtime-only', 'runtime-refused'], ['runtime-refused', 'runtime-refused'],
        ['capacity', 'capacity'], [undefined, 'not-spawned']]) {
        expect(await run({ spawned: false, reason })).toEqual([{ ...entry, action: 'not-spawned', reason: expected }]);
        expect(reserveRoute(entry).ok).toBe(true);
        expect(releaseRoute(entry).released).toBe(true);
      }
      expect(await run({ spawned: true, pid: 123 })).toEqual([{ ...entry, action: 'landing-spawned' }]);
      expect(reserveRoute(entry).ok).toBe(false);
      expect(await run({ spawned: true })).toEqual([{ ...entry, action: 'already-in-flight' }]);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  it('a refused spawn remains not-spawned when best-effort lease release throws', async () => {
    const outcomes = await routeHeldItems({
      plan: [{ num: '4380', route: 'already-done' }], readSettings: () => ({}),
      reserveRoute: () => ({ ok: true }), releaseRoute: () => { throw new Error('release failed'); },
      spawnLand: async () => ({ spawned: false, reason: 'runtime-only' }),
    });
    expect(outcomes).toEqual([{ num: '4380', route: 'already-done', action: 'not-spawned', reason: 'runtime-refused' }]);
  });

  it('a SYNCHRONOUSLY throwing spawn is captured per-item, never thrown past routeHeldItems, and releases '
    + 'the lease it just took (the spawn never even started — retry promptly, never wait out the full TTL)', async () => {
    const released = [];
    const outcomes = await routeHeldItems({
      plan: [{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'x' }],
      reserveRoute: () => ({ ok: true }),
      releaseRoute: (a) => { released.push(a); },
      spawnLand: () => { throw new Error('spawn failed: ENOENT'); },
    });
    expect(outcomes).toEqual([{ num: '4380', route: 'already-done', action: 'spawn-failed', error: 'spawn failed: ENOENT' }]);
    expect(released).toEqual([{ num: '4380', route: 'already-done' }]);
  });

  // Production's `spawnLand` (`cliSpawnHoldLand`) is itself ASYNC — a dynamic `import()` then a detached
  // spawn — so its failure mode is a REJECTED promise, not a synchronous throw. Without an `await` in front
  // of `spawnLand(entry)`, the `try/catch` around it never sees the rejection at all: this test would see
  // `'landing-spawned'` even though nothing actually spawned, and the rejection would instead surface later
  // as a process-level `unhandledRejection` (which can kill the resident daemon by default) — this is the
  // exact bug this async rewrite closes.
  it('an ASYNCHRONOUSLY rejecting spawn (the real cliSpawnHoldLand failure mode) is also captured as '
    + 'spawn-failed and releases the lease, never left as an unhandled rejection', async () => {
    const released = [];
    const outcomes = await routeHeldItems({
      plan: [{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'x' }],
      reserveRoute: () => ({ ok: true }),
      releaseRoute: (a) => { released.push(a); },
      spawnLand: async () => { throw new Error('detached spawn: ENOENT'); },
    });
    expect(outcomes).toEqual([{ num: '4380', route: 'already-done', action: 'spawn-failed', error: 'detached spawn: ENOENT' }]);
    expect(released).toEqual([{ num: '4380', route: 'already-done' }]);
  });

  it("a THROWING recordFinding (route 'other') is captured as finding-failed and also releases the lease "
    + 'it just took', async () => {
    const released = [];
    const outcomes = await routeHeldItems({
      plan: [{ num: 'x0e7udq', route: 'other', commit: null, reason: 'wrapper-threw' }],
      reserveRoute: () => ({ ok: true }),
      releaseRoute: (a) => { released.push(a); },
      recordFinding: () => { throw new Error('ledger write failed: EACCES'); },
    });
    expect(outcomes).toEqual([{ num: 'x0e7udq', route: 'other', action: 'finding-failed', error: 'ledger write failed: EACCES' }]);
    expect(released).toEqual([{ num: 'x0e7udq', route: 'other' }]);
  });

  it('a THROWING releaseRoute after a spawn failure never escapes routeHeldItems (best-effort — the TTL '
    + 'still bounds the lease either way)', async () => {
    const outcomes = await routeHeldItems({
      plan: [{ num: '4380', route: 'already-done', commit: 'b93d13e29', reason: 'x' }],
      reserveRoute: () => ({ ok: true }),
      releaseRoute: () => { throw new Error('release also failed'); },
      spawnLand: () => { throw new Error('spawn failed: ENOENT'); },
    });
    expect(outcomes).toEqual([{ num: '4380', route: 'already-done', action: 'spawn-failed', error: 'spawn failed: ENOENT' }]);
  });

  it('an empty/non-array plan produces no outcomes', async () => {
    expect(await routeHeldItems({ plan: [] })).toEqual([]);
    expect(await routeHeldItems({ plan: null })).toEqual([]);
  });
});

describe('holdRouteLockRoot / holdFindingsFile — coordination-root-relative paths', () => {
  it('both live under the given coordination root, distinct from every other build-dispatch lock family', () => {
    const root = '/tmp/coord-root-example';
    expect(holdRouteLockRoot(root)).toBe(join(root, 'build-dispatch-hold-routes'));
    expect(holdFindingsFile(root)).toBe(join(root, 'build-dispatch-hold-findings.json'));
  });
});

// #4465 review round 3 (live correctness finding) — a route lease shorter than the hold's own TTL lets a
// LATER tick re-route the SAME hold a second time after the first landing already succeeded (and possibly
// already merged and been re-prepared), silently undoing it. This asserts the invariant that fix relies on,
// so the two constants can never silently drift apart again.
describe('DEFAULT_ROUTE_LEASE_MINUTES vs the build-dispatch hold TTL', () => {
  it('the route lease always outlives the hold it guards — never a second landing while one hold is still live', () => {
    expect(DEFAULT_ROUTE_LEASE_MINUTES).toBeGreaterThan(DEFAULT_BUILD_DISPATCH_HOLD_MINUTES);
  });
});
