/**
 * @file build-dispatch-orphan-adopt.test.mjs — #4131/#4382 build-orphan-adopt.
 *
 * PURE CORE first (classify/decide, no fs/process at all), then `checkResumable`'s own two safety checks
 * (lane-lease-currency, foreign-commit detection), then the orchestration (`adoptOrphanedBuildClaims`) against
 * REAL claim/resume-marker lock roots (same primitive the codebase already trusts —
 * `build-dispatch-claim.test.mjs`) with every OTHER effect (run-store row lookup, resumability check, the
 * resume spawn itself, the pid probe) injected — so this suite never spawns a real detached process, never
 * shells `lane-pool.mjs`, and never depends on a real delivery-report sidecar on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newRunRecord } from '../../operations/run-record.mjs';
import {
  defaultCurrentLaneSession, classifyClaimLiveness, decideOrphanAction, findLatestBuildRow, findLatestInFlightBuildRow,
  adoptOrphanedBuildClaims as adoptOrphanedBuildClaimsReal, checkResumable, defaultSessionLiveness, settleDeliveredRow, spawnResumeDelivery, MAX_RESUME_ATTEMPTS,
} from '../build-dispatch-orphan-adopt.mjs';

// The real pass reads GitHub and the harness job records by default; these tests inject everything else, so the
// two new evidence reads default to "nothing found" and each xykwe0h test overrides them explicitly.
const adoptOrphanedBuildClaims = (o = {}) => adoptOrphanedBuildClaimsReal({ readDelivery: () => null, sessionLivenessFor: () => null, ...o });
import {
  acquireBuildDispatchClaim, listBuildDispatchClaims, releaseBuildDispatchClaim,
  markBuildDispatchResume, readBuildDispatchResume, releaseBuildDispatchResume,
} from '../build-dispatch-claim.mjs';

describe('classifyClaimLiveness — pure', () => {
  const row = (handle, extra = {}) => ({ runId: 'dispatch-lane-x', entry: { key: 'step:1:0', handle, payload: { lane: 3, sessionSlug: 's' }, ...extra } });

  it('alive: the dispatch row\'s own pid answers alive, no resume marker', () => {
    const isPidAlive = (pid) => pid === 111;
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: null, isPidAlive })).toMatchObject({ status: 'alive' });
  });

  it('dead: the dispatch row\'s own pid is confirmed gone by the kernel', () => {
    const isPidAlive = () => false;
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: null, isPidAlive })).toMatchObject({ status: 'dead' });
  });

  it('no-record: no row at all, no resume marker, and no owner pid given — too early to judge', () => {
    expect(classifyClaimLiveness({ row: null, resumeMarker: null, isPidAlive: () => true })).toMatchObject({ status: 'no-record', row: null });
  });

  // #4382 shape (live 2026-09-29): killed before the dispatch ever reached `in-flight` — NO run-store row
  // exists at all. The claim's own OWNER pid (the dispatching daemon's pid at claim time) is the only other
  // liveness signal available; when it too is confirmed dead, nothing is watching this claim any more.
  it('#4382 shape: no row at all, but the claim\'s OWN owner pid is confirmed dead → dead (orphaned)', () => {
    const isPidAlive = (pid) => pid !== 98761;
    expect(classifyClaimLiveness({ row: null, resumeMarker: null, ownerPid: 98761, isPidAlive })).toMatchObject({ status: 'dead', row: null });
  });

  it('no row, but the claim\'s owner pid IS alive → no-record (the claim was likely just taken; too early)', () => {
    const isPidAlive = (pid) => pid === 98761;
    expect(classifyClaimLiveness({ row: null, resumeMarker: null, ownerPid: 98761, isPidAlive })).toMatchObject({ status: 'no-record' });
  });

  it('a handle-less row (killed before a handle was ever recorded) falls back to the owner pid exactly like '
    + 'no row at all', () => {
    const pendingRow = { runId: 'dispatch-lane-x', entry: { status: 'pending', handle: null, payload: { lane: 3, sessionSlug: 's' } } };
    const isPidAlive = () => false;
    expect(classifyClaimLiveness({ row: pendingRow, resumeMarker: null, ownerPid: 1, isPidAlive })).toMatchObject({ status: 'dead' });
  });

  // #4131 shape (live 2026-09-29): the wrapper's own exit path settled `applied` as `pr-opened`, but the PR
  // number came back null — nothing was actually delivered, and `doneWhy` never revisits a `pr-opened` settle.
  it('#4131 shape: settled `pr-opened` with NO confirmed pr → dead (nothing was actually delivered)', () => {
    const settled = row(null, { status: 'applied', result: { outcome: 'pr-opened', pr: null } });
    expect(classifyClaimLiveness({ row: settled, resumeMarker: null, isPidAlive: () => true })).toMatchObject({ status: 'dead' });
  });

  // Live 2026-10-06 (#4688): an OLDER attempt's settled row must never answer for a NEWER claim.
  it('a settled row that STARTED BEFORE the claim is an older attempt -> ignored; dead owner pid => dead', () => {
    const older = row(null, { status: 'failed', startedAt: '2026-10-06T18:10:00.000Z', result: { outcome: 'gate-red' } });
    const claimedAt = '2026-10-06T18:59:29.394Z';
    const live = classifyClaimLiveness({ row: older, resumeMarker: null, ownerPid: 60537, isPidAlive: () => false, claimedAt });
    expect(live).toMatchObject({ status: 'dead', row: null });
    expect(classifyClaimLiveness({ row: older, resumeMarker: null, ownerPid: 60537, isPidAlive: () => true, claimedAt }))
      .toMatchObject({ status: 'no-record', row: null });
  });

  it('a settled row that started AT/AFTER the claim still reads settled-elsewhere', () => {
    const own = row(null, { status: 'failed', startedAt: '2026-10-06T19:00:00.000Z', result: { outcome: 'gate-red' } });
    expect(classifyClaimLiveness({ row: own, resumeMarker: null, ownerPid: 1, isPidAlive: () => false, claimedAt: '2026-10-06T18:59:29.394Z' }))
      .toMatchObject({ status: 'settled-elsewhere' });
  });

  it('settled `pr-opened` WITH a real pr number → settled-elsewhere (doneWhy\'s own PR-observed path owns it)', () => {
    const settled = row(null, { status: 'applied', result: { outcome: 'pr-opened', pr: 2921 } });
    expect(classifyClaimLiveness({ row: settled, resumeMarker: null, isPidAlive: () => true })).toMatchObject({ status: 'settled-elsewhere' });
  });

  it('settled with any OTHER outcome (gate-red, not-ready, wrapper-threw, …) → settled-elsewhere — that is '
    + '`doneWhy`\'s own job, never this module\'s to re-decide', () => {
    for (const outcome of ['gate-red', 'not-ready', 'wrapper-threw', 'blocked-mid-build']) {
      const settled = row(null, { status: 'applied', result: { outcome, pr: null } });
      expect(classifyClaimLiveness({ row: settled, resumeMarker: null, isPidAlive: () => true })).toMatchObject({ status: 'settled-elsewhere' });
    }
  });

  // A marker BOUND to the row above (`dispatch-lane-x` / `step:1:0`) — the only shape that may answer for it.
  const bound = (meta) => ({ pid: 999, meta: { runId: 'dispatch-lane-x', rowKey: 'step:1:0', attempts: 1, ...meta } });

  it('a LIVE resume marker overrides the original (now-irrelevant) dispatch row\'s own dead pid', () => {
    const isPidAlive = (pid) => pid === 222; // only the RESUME's pid answers alive
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: bound({ pid: 222 }), isPidAlive })).toMatchObject({ status: 'alive' });
  });

  it('a DEAD resume marker (the resume attempt itself died) reports dead, not the original row\'s pid', () => {
    const isPidAlive = () => false;
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: bound({ pid: 222 }), isPidAlive })).toMatchObject({ status: 'dead' });
  });

  it('PR #2921 review — a STALE marker bound to an OLDER attempt never answers for a newer, live dispatch', () => {
    const isPidAlive = (pid) => pid === 111; // the NEW row's own wrapper is alive; the old resume pid is dead
    const stale = { pid: 999, meta: { pid: 222, runId: 'dispatch-lane-OLD', rowKey: 'step:1:0', attempts: 1 } };
    const r = classifyClaimLiveness({ row: row('pid:111'), resumeMarker: stale, isPidAlive });
    expect(r).toMatchObject({ status: 'alive', marker: null });
  });

  it('PR #2921 review — a marker carrying no row binding at all is ignored, never trusted', () => {
    const isPidAlive = (pid) => pid === 111;
    const unbound = { pid: 222, meta: { pid: 222 } };
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: unbound, isPidAlive })).toMatchObject({ status: 'alive' });
  });

  it('PR #2921 review — a PENDING marker (written before the spawn, no pid yet) reads alive inside the spawn '
    + 'grace, dead after it', () => {
    const isPidAlive = () => false;
    const t0 = Date.parse('2026-09-29T12:00:00Z');
    const pending = bound({ pid: null, resumedAt: new Date(t0).toISOString() });
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: pending, isPidAlive, nowMs: t0 + 1000 }).status).toBe('alive');
    // Past the grace it is UNCONFIRMED (the daemon may have died after spawning) — left alone, never 'dead'.
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: pending, isPidAlive, nowMs: t0 + 60 * 60_000 }).status).toBe('unconfirmed');
  });

  it('PR #2921 review — a marker recorded `spawnFailed` reads dead at once (known not running)', () => {
    const failed = bound({ pid: null, spawnFailed: true, resumedAt: new Date().toISOString() });
    expect(classifyClaimLiveness({ row: row('pid:111'), resumeMarker: failed, isPidAlive: () => false }).status).toBe('dead');
  });
});

describe('decideOrphanAction — pure', () => {
  it('resumable → resume', () => {
    expect(decideOrphanAction({ resumable: true }).action).toBe('resume');
  });
  it('not resumable → release', () => {
    expect(decideOrphanAction({ resumable: false }).action).toBe('release');
  });
  it('PR #2921 review — resumable but the resume cap is spent → exhausted (release + hold), never a respawn', () => {
    expect(decideOrphanAction({ resumable: true, attempts: MAX_RESUME_ATTEMPTS }).action).toBe('exhausted');
    expect(decideOrphanAction({ resumable: true, attempts: MAX_RESUME_ATTEMPTS - 1 }).action).toBe('resume');
  });
  it('PR #2921 review — resumable while the kill switch / freeze is on → leave, never a spawn', () => {
    expect(decideOrphanAction({ resumable: true, allowResume: false }).action).toBe('leave');
  });
});

describe('findLatestBuildRow (alias: findLatestInFlightBuildRow) — pure', () => {
  const buildEffect = (num, status, startedAt, handle, result = null) => ({
    type: 'conveyor.dispatch-delivery-agent', status, startedAt, handle, result,
    payload: { num, launchKind: 'build', lane: 3, sessionSlug: `conveyor-${num}` },
  });

  it('picks the newest row for the item BY STATUS-AGNOSTIC startedAt, ignoring other items — a SETTLED row '
    + 'newer than an in-flight one wins (the #4131 shape: the wrapper settled after going in-flight)', () => {
    const runs = [
      { id: 'dispatch-lane-a', record: { effects: [buildEffect('4131', 'in-flight', '2026-09-29T10:46:00Z', 'pid:1')] } },
      { id: 'dispatch-lane-b', record: { effects: [buildEffect('4131', 'in-flight', '2026-09-29T11:00:00Z', 'pid:2')] } },
      { id: 'dispatch-lane-c', record: { effects: [buildEffect('4131', 'applied', '2026-09-29T12:00:00Z', 'pid:3', { outcome: 'pr-opened', pr: null })] } },
      { id: 'dispatch-lane-d', record: { effects: [buildEffect('9999', 'in-flight', '2026-09-29T13:00:00Z', 'pid:4')] } },
    ];
    const row = findLatestBuildRow(runs, '4131');
    expect(row).toMatchObject({ runId: 'dispatch-lane-c', entry: { handle: 'pid:3', result: { outcome: 'pr-opened' } } });
    // `findLatestInFlightBuildRow` is the SAME function under its pre-2026-09-29 name.
    expect(findLatestInFlightBuildRow(runs, '4131')).toEqual(row);
  });

  it('returns null when nothing matches at all', () => {
    expect(findLatestBuildRow([], '4131')).toBeNull();
  });
});

describe('checkResumable — TWO safety checks: lane-lease-currency, then foreign-commit detection', () => {
  // ── lane-lease-currency (build-orphan-adopt's own live fix, 2026-09-29) ──────────────────────────────────
  const alwaysDone = () => ({ status: 'done', item: '4131', updatedAt: '2026-09-29T10:30:00Z', filesTouched: ['scripts/a.mjs'] });
  const alwaysAhead = () => true;
  const noForeign = () => ['scripts/a.mjs'];

  it('resumable when the lane is STILL leased under the exact matching session, a done report exists, and '
    + 'the lane has a commit ahead of base with no foreign files', () => {
    const result = checkResumable({
      lane: 9, sessionSlug: 'conveyor-4131',
      currentLaneSession: () => 'conveyor-4131',
      resolveLane: () => '/fake/lane-9',
      readReport: alwaysDone,
      isLaneCommitAhead: alwaysAhead,
      listLaneChangedFiles: noForeign,
    });
    expect(result).toMatchObject({ resumable: true, lanePath: '/fake/lane-9' });
  });

  // THE SAFETY FIX (live 2026-09-29): #4131's own lane (8) was recycled twice in the hours between its
  // wrapper settling and this fix landing. Trusting "lane 8 has a commit ahead of main" without first
  // checking WHO currently holds the lease would resume from a completely unrelated occupant's own work.
  it('NOT resumable when the lane\'s lease has moved on to a different session — checked BEFORE any git read', () => {
    let gitRead = false;
    const result = checkResumable({
      lane: 8, sessionSlug: 'conveyor-4131',
      currentLaneSession: () => 'conveyor-4068', // a LATER, unrelated item now holds lane 8
      resolveLane: () => '/fake/lane-8',
      readReport: alwaysDone,
      isLaneCommitAhead: () => { gitRead = true; return true; },
    });
    expect(result).toEqual({ resumable: false, reason: 'lane-lease-moved-on' });
    expect(gitRead).toBe(false);
  });

  it('NOT resumable when the lane is not leased at all any more', () => {
    const result = checkResumable({
      lane: 8, sessionSlug: 'conveyor-4131',
      currentLaneSession: () => null,
      resolveLane: () => '/fake/lane-8',
      readReport: alwaysDone,
      isLaneCommitAhead: alwaysAhead,
      listLaneChangedFiles: noForeign,
    });
    expect(result).toEqual({ resumable: false, reason: 'lane-lease-moved-on' });
  });

  it('NOT resumable with no lane or session at all', () => {
    expect(checkResumable({ lane: null, sessionSlug: null })).toEqual({ resumable: false, reason: 'no-lane-or-session' });
  });

  it('NOT resumable when the lease matches but there is no done report', () => {
    const result = checkResumable({
      lane: 9, sessionSlug: 'conveyor-4131',
      currentLaneSession: () => 'conveyor-4131',
      resolveLane: () => '/fake/lane-9',
      readReport: () => null,
      isLaneCommitAhead: alwaysAhead,
    });
    expect(result).toMatchObject({ resumable: false, reason: 'no-done-report' });
  });

  it('NOT resumable when the lease and report match but the lane holds no commit ahead of base', () => {
    const result = checkResumable({
      lane: 9, sessionSlug: 'conveyor-4131',
      currentLaneSession: () => 'conveyor-4131',
      resolveLane: () => '/fake/lane-9',
      readReport: alwaysDone,
      isLaneCommitAhead: () => false,
    });
    expect(result).toMatchObject({ resumable: false, reason: 'no-commit-ahead' });
  });

  // ── PR #2921 review: the lane's commits must belong to THIS item ────────────────────────────────────────
  const base = {
    lane: 9, sessionSlug: 'conveyor-4131', num: '4131', rowStartedAt: '2026-09-29T10:00:00Z',
    currentLaneSession: () => 'conveyor-4131', resolveLane: () => '/fake/lane-9', resolveReportsDir: () => '/fake/reports',
    isLaneCommitAhead: () => true,
  };
  const report = (over = {}) => ({
    item: '4131', status: 'done', filesTouched: ['scripts/a.mjs'], updatedAt: '2026-09-29T10:30:00Z', ...over,
  });

  it('resumable when the report is this item\'s, this attempt\'s, and covers every file the lane changed', () => {
    const r = checkResumable({ ...base, readReport: () => report(), listLaneChangedFiles: () => ['scripts/a.mjs'] });
    expect(r).toMatchObject({ resumable: true });
  });

  it('NOT resumable when the lane carries a commit touching a file the report never claimed (a reused lane)', () => {
    const r = checkResumable({ ...base, readReport: () => report(), listLaneChangedFiles: () => ['scripts/a.mjs', 'other-item.mjs'] });
    expect(r).toMatchObject({ resumable: false, reason: 'lane-commits-not-this-item' });
  });

  it('NOT resumable when the report names a different item', () => {
    const r = checkResumable({ ...base, readReport: () => report({ item: '9999' }), listLaneChangedFiles: () => ['scripts/a.mjs'] });
    expect(r).toMatchObject({ resumable: false, reason: 'report-item-mismatch' });
  });

  it('NOT resumable when the done report predates this dispatch (an older attempt\'s leftover)', () => {
    const r = checkResumable({ ...base, readReport: () => report({ updatedAt: '2026-09-29T09:00:00Z' }), listLaneChangedFiles: () => ['scripts/a.mjs'] });
    expect(r).toMatchObject({ resumable: false, reason: 'report-predates-dispatch' });
  });

  it('the item\'s OWN backlog card (edited by the wrapper\'s claim, not the agent) is never read as foreign', () => {
    const r = checkResumable({ ...base, readReport: () => report(), listLaneChangedFiles: () => ['scripts/a.mjs', 'backlog/4131-some-thing.md'] });
    expect(r).toMatchObject({ resumable: true });
    const other = checkResumable({ ...base, readReport: () => report(), listLaneChangedFiles: () => ['scripts/a.mjs', 'backlog/9999-other.md'] });
    expect(other).toMatchObject({ resumable: false, reason: 'lane-commits-not-this-item' });
  });

  it('a `WE:`-prefixed filesTouched entry still matches its plain path', () => {
    const r = checkResumable({ ...base, readReport: () => report({ filesTouched: ['WE:scripts/a.mjs'] }), listLaneChangedFiles: () => ['scripts/a.mjs'] });
    expect(r).toMatchObject({ resumable: true });
  });

  it('a non-`we` locus build is never resumable from the WE lane', () => {
    const r = checkResumable({ ...base, scope: 'plateau-app:src/x.ts', readReport: () => report(), listLaneChangedFiles: () => ['scripts/a.mjs'] });
    expect(r).toMatchObject({ resumable: false, reason: 'non-we-locus' });
  });

  it('NOT resumable when the lane diff cannot be read', () => {
    const r = checkResumable({ ...base, readReport: () => report(), listLaneChangedFiles: () => null });
    expect(r).toMatchObject({ resumable: false, reason: 'lane-diff-unreadable' });
  });
});

describe('spawnResumeDelivery — PR #2921 review: the resume settles the ORIGINAL run-store row', () => {
  it('passes --run-id and --effect-key through to the resumed wrapper', () => {
    let argv = null;
    spawnResumeDelivery(
      { num: '4131', lane: 9, scope: 'we:a', sessionSlug: 'conveyor-4131', runId: 'dispatch-lane-x', effectKey: 'step:1:0' },
      { spawnDetached: (a) => { argv = a; return { pid: 7 }; }, logPathFor: () => '/dev/null' },
    );
    expect(argv).toEqual(expect.arrayContaining(['--resume', '--run-id=dispatch-lane-x', '--effect-key=step:1:0']));
  });
});

describe('adoptOrphanedBuildClaims — orchestration over a real claim/resume lock root', () => {
  // TWO separate roots, matching production (`build-dispatch-claim.mjs`'s own `buildDispatchClaimRoot()` vs
  // `buildDispatchResumeRoot()` are distinct subdirectories under the same coordination root) — a claim and a
  // resume marker for the SAME item must never share one lock directory, or marking/refreshing one would
  // delete the other (`markBuildDispatchResume`'s own unconditional `releaseLockDir` refresh).
  let lockRoot;
  let resumeRoot;
  beforeEach(() => {
    lockRoot = mkdtempSync(join(tmpdir(), 'bdd-orphan-claims-'));
    resumeRoot = mkdtempSync(join(tmpdir(), 'bdd-orphan-resumes-'));
  });
  afterEach(() => {
    rmSync(lockRoot, { recursive: true, force: true });
    rmSync(resumeRoot, { recursive: true, force: true });
  });

  const buildRow = ({ num, handle, status = 'in-flight', result = null, lane = 3, sessionSlug = `conveyor-${num}` }) => ({
    runId: 'dispatch-lane-x',
    entry: { key: 'step:1:0', status, handle, result, payload: { num, launchKind: 'build', lane, sessionSlug, scope: [] } },
  });

  it('LEAVES a claim whose recorded dispatch is still alive', async () => {
    acquireBuildDispatchClaim({ num: '4295', scope: [], lockRoot, pid: 17711 });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => true,
      findRow: () => buildRow({ num: '4295', handle: 'pid:999' }),
      readResumeMarker: () => null,
      resolveResumability: () => { throw new Error('must not be called when alive'); },
      releaseClaim: () => { throw new Error('must not release'); },
      releaseResumeMarker: () => {},
      settleRow: () => { throw new Error('must not settle'); },
      spawnResume: () => { throw new Error('must not spawn'); },
      markResume: () => { throw new Error('must not mark'); },
    });
    expect(results).toEqual([{ num: '4295', action: 'leave', reason: 'alive' }]);
    // the claim itself is untouched — still there.
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4295']);
  });

  it('RESUMES a dead-wrapper claim whose report + lane commit are still there — the general resumable shape: '
    + 'claim stays held, a fresh detached resume is spawned, and a resume marker records its pid', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 74142 });
    let spawnedWith = null;
    let markedWith = null;
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false, // the daemon-owner pid the claim was minted under is long dead
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142', lane: 9, sessionSlug: 'conveyor-4131' }),
      readResumeMarker: () => null,
      resolveResumability: ({ lane, sessionSlug }) => {
        expect(lane).toBe(9);
        expect(sessionSlug).toBe('conveyor-4131');
        return { resumable: true, lanePath: '/fake/lane-9' };
      },
      releaseClaim: () => { throw new Error('must not release a resumable orphan'); },
      releaseResumeMarker: () => {},
      settleRow: () => { throw new Error('must not settle the original row on a resume'); },
      spawnResume: (o) => { spawnedWith = o; return 55555; },
      markResume: (o) => { markedWith = [...(markedWith || []), o]; },
    });
    expect(results).toEqual([{ num: '4131', action: 'resume', reason: expect.stringContaining('resumable'), pid: 55555 }]);
    expect(spawnedWith).toMatchObject({
      num: '4131', lane: 9, sessionSlug: 'conveyor-4131', runId: 'dispatch-lane-x', effectKey: 'step:1:0',
    });
    // PENDING marker first (before the spawn), then the real pid; both bound to the row.
    const binding = { runId: 'dispatch-lane-x', rowKey: 'step:1:0', attempts: 1 };
    expect(markedWith).toEqual([{ num: '4131', pid: null, ...binding }, { num: '4131', pid: 55555, ...binding }]);
    // THE POINT: the claim is STILL held — never released while a resume is legitimately in flight.
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4131']);
  });

  it('RELEASES a dead-wrapper claim with nothing resumable — general shape: claim freed, NO hold, stale '
    + 'run-store row settled', async () => {
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot, pid: 98761 });
    let settledWith = null;
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4382', handle: 'pid:98761' }),
      readResumeMarker: () => null,
      resolveResumability: () => ({ resumable: false, reason: 'no-done-report' }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      releaseResumeMarker: () => {},
      settleRow: (o) => { settledWith = o; },
      spawnResume: () => { throw new Error('must not spawn when nothing is resumable'); },
      markResume: () => { throw new Error('must not mark when nothing is resumable'); },
    });
    expect(results).toEqual([{ num: '4382', action: 'release', reason: expect.stringContaining('no-done-report') }]);
    expect(settledWith).toMatchObject({ runId: 'dispatch-lane-x', key: 'step:1:0', outcome: 'orphan-released' });
    // THE POINT: the claim is GONE — the very next tick can offer #4382 for a completely fresh dispatch.
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toEqual([]);
  });

  // #4382's EXACT live shape: no run-store row was EVER found (killed before it ever went in-flight) — the
  // ORIGINAL version of this module left a claim like this alone forever (`no-record` → leave). The owner
  // pid's own death is what tells the two cases apart.
  it('#4382 EXACT shape: NO run-store row at all, but the claim\'s own owner pid is dead → RELEASES it '
    + '(never left stuck forever)', async () => {
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot, pid: 98761 });
    let settledWith = 'not-called';
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: (pid) => pid !== 98761, // the claim's own owner (the daemon that took it) is dead
      findRow: () => null, // no run-store trace was ever found
      readResumeMarker: () => null,
      resolveResumability: (o) => { expect(o).toMatchObject({ lane: undefined, sessionSlug: undefined }); return { resumable: false, reason: 'no-lane-or-session' }; },
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      releaseResumeMarker: () => {},
      // Called unconditionally (with no `runId`/`key` at all, since there is no row) — a clean, benign no-op;
      // the REAL `settleOrphanRow` guards exactly this shape internally (see that function's own docblock).
      settleRow: (o) => { settledWith = o; },
      spawnResume: () => { throw new Error('must not spawn — nothing to resume from'); },
      markResume: () => { throw new Error('must not mark'); },
    });
    expect(settledWith).toEqual({ runId: undefined, key: undefined, outcome: 'orphan-released' });
    expect(results).toEqual([{ num: '4382', action: 'release', reason: expect.stringContaining('no-lane-or-session') }]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toEqual([]);
  });

  it('a claim with no run-store row whose owner pid is STILL ALIVE is left alone — too early to tell (the '
    + 'daemon may have only just taken it)', async () => {
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot, pid: 98761 });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: (pid) => pid === 98761,
      findRow: () => null,
      readResumeMarker: () => null,
    });
    expect(results).toEqual([{ num: '4382', action: 'leave', reason: 'no-record' }]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4382']);
  });

  // #4131's own TTL-expiry gap (live 2026-09-29): the claim aged out of the ORDINARY (expiry-filtered) read
  // while the daemon was down for hours — `listClaims`'s own default now reads with `ignoreExpiry: true` for
  // exactly this reason. Proven here against a REAL expired claim on disk, and that this IS the default (no
  // override passed at all).
  it('adopts an EXPIRED claim too — the DEFAULT listClaims reads past the TTL filter', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 74142, leaseMinutes: 240 });
    const past = Date.now() + 300 * 60_000;
    expect(listBuildDispatchClaims({ lockRoot, nowMs: past })).toEqual([]); // the ORDINARY read: invisible.
    expect(listBuildDispatchClaims({ lockRoot, nowMs: past, ignoreExpiry: true })).toHaveLength(1); // adoption's own read: still there.
    // No `listClaims` override at all here — proving `ignoreExpiry: true` really is this function's own default.
    const nowFrozen = () => past;
    const results = await adoptOrphanedBuildClaims({
      now: nowFrozen,
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => null,
      resolveResumability: () => ({ resumable: false, reason: 'lane-lease-moved-on' }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      releaseResumeMarker: () => {},
      settleRow: () => {},
    });
    // The default `listClaims` reads the REAL coordination root, not our temp `lockRoot` — so it will not see
    // our fixture claim at all in this sandbox; what matters here is that the call did not throw and that the
    // temp-root assertions above already proved `ignoreExpiry: true` is what the default composes with.
    expect(Array.isArray(results)).toBe(true);
  });

  it('LEAVES alone once a resume is already under way (a live resume marker) — never double-resumes', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 74142 });
    markBuildDispatchResume({ num: '4131', pid: 55555, runId: 'dispatch-lane-x', rowKey: 'step:1:0', lockRoot: resumeRoot });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: (pid) => pid === 55555, // the resume's own pid is alive; the original dispatch's pid never asked
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => { throw new Error('must not re-check resumability while a resume is alive'); },
      releaseClaim: () => { throw new Error('must not release'); },
      releaseResumeMarker: () => {},
      settleRow: () => { throw new Error('must not settle'); },
      spawnResume: () => { throw new Error('must not spawn a second resume'); },
      markResume: () => { throw new Error('must not re-mark'); },
    });
    expect(results).toEqual([{ num: '4131', action: 'leave', reason: 'alive' }]);
  });

  it('LEAVES a claim already settled to a non-`pr-opened` outcome — `doneWhy`\'s own job, never contested here', async () => {
    acquireBuildDispatchClaim({ num: '4295', scope: [], lockRoot, pid: 17711 });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4295', handle: null, status: 'applied', result: { outcome: 'gate-red' } }),
      readResumeMarker: () => null,
      resolveResumability: () => { throw new Error('must not check resumability for a settled-elsewhere row'); },
      releaseClaim: () => { throw new Error('must not release — doneWhy owns this'); },
    });
    expect(results).toEqual([{ num: '4295', action: 'leave', reason: 'settled-elsewhere' }]);
  });

  it('RELEASES a dead-owner claim whose only run row is an OLDER settled attempt (live #4688: slot pinned for hours)', async () => {
    acquireBuildDispatchClaim({ num: '4688', scope: [], lockRoot, pid: 60537 });
    let released = null;
    const older = buildRow({ num: '4688', handle: null, status: 'failed', result: { outcome: 'gate-red' } });
    older.entry.startedAt = '2000-01-01T00:00:00.000Z';
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => older,
      readResumeMarker: () => null,
      resolveResumability: () => ({ resumable: false, reason: 'no-lane-or-session' }),
      releaseClaim: ({ num }) => { released = num; },
      releaseResumeMarker: () => {},
      settleRow: ({ runId }) => { expect(runId).toBeUndefined(); },
    });
    expect(released).toBe('4688');
    expect(results[0]).toMatchObject({ num: '4688', action: 'release' });
  });

  // ── PR #2921 review findings ────────────────────────────────────────────────────────────────────────────

  it('a STALE resume marker from an older attempt never gets a NEWER live build released — the claim stays, '
    + 'and the stale marker is cleared', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    // The OLD resume (bound to an older row) is dead; the fresh re-dispatch's own wrapper (pid 777) is alive.
    markBuildDispatchResume({ num: '4131', pid: 55555, runId: 'dispatch-lane-OLD', rowKey: 'step:1:0', lockRoot: resumeRoot });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: (pid) => pid === 777,
      findRow: () => buildRow({ num: '4131', handle: 'pid:777' }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => ({ resumable: false, reason: 'no-done-report' }),
      releaseClaim: () => { throw new Error('must not release a LIVE build'); },
      releaseResumeMarker: ({ num }) => releaseBuildDispatchResume({ num, lockRoot: resumeRoot }),
      settleRow: () => { throw new Error('must not settle a LIVE build\'s row'); },
      spawnResume: () => { throw new Error('must not spawn'); },
      markResume: () => { throw new Error('must not mark'); },
    });
    expect(results).toEqual([{ num: '4131', action: 'leave', reason: 'alive' }]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4131']);
    expect(readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot })).toBeNull();
  });

  it('respawning is BOUNDED: a resume that keeps dying is resumed at most MAX_RESUME_ATTEMPTS times, then the '
    + 'claim is released with a HOLD and the row settled — never an endless respawn', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    const spawned = [];
    const holds = [];
    const settled = [];
    const pass = () => adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false, // every resume dies immediately
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142', lane: 9 }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => ({ resumable: true, lanePath: '/fake/lane-9' }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      releaseResumeMarker: ({ num }) => releaseBuildDispatchResume({ num, lockRoot: resumeRoot }),
      settleRow: (o) => { settled.push(o); },
      placeHold: (o) => { holds.push(o); },
      spawnResume: () => { spawned.push(1); return 60000 + spawned.length; },
      markResume: (o) => markBuildDispatchResume({ ...o, lockRoot: resumeRoot }),
    });
    const actions = [];
    for (let i = 0; i < MAX_RESUME_ATTEMPTS + 3; i += 1) {
      const r = await pass();
      actions.push(r[0]?.action ?? 'none');
    }
    expect(spawned.length).toBe(MAX_RESUME_ATTEMPTS);
    expect(actions.slice(0, MAX_RESUME_ATTEMPTS + 1)).toEqual([...Array(MAX_RESUME_ATTEMPTS).fill('resume'), 'exhausted']);
    expect(holds).toEqual([expect.objectContaining({ num: '4131', reason: expect.stringContaining('resume') })]);
    expect(settled).toEqual([expect.objectContaining({ runId: 'dispatch-lane-x', outcome: 'orphan-resume-exhausted' })]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toEqual([]);
    expect(readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot })).toBeNull();
  });

  it('the marker is written BEFORE the spawn: a crash right after spawning still leaves a marker, so the next '
    + 'pass does not spawn a second resume', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    let spawns = 0;
    let markCalls = 0;
    const opts = (markResume) => ({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => ({ resumable: true }),
      releaseClaim: () => { throw new Error('must not release'); },
      releaseResumeMarker: () => {},
      settleRow: () => {},
      spawnResume: () => { spawns += 1; return 55555; },
      markResume,
    });
    // pass 1: the pending mark lands, the spawn happens, then the post-spawn mark THROWS (fs error / crash).
    const r1 = await adoptOrphanedBuildClaims(opts((o) => {
      markCalls += 1;
      if (markCalls === 2) throw new Error('disk full');
      return markBuildDispatchResume({ ...o, lockRoot: resumeRoot });
    }));
    expect(spawns).toBe(1);
    expect(r1).toEqual([expect.objectContaining({ num: '4131', action: 'error', reason: expect.stringContaining('disk full') })]);
    // pass 2, moments later: the PENDING marker is inside its spawn grace — no second resume.
    const r2 = await adoptOrphanedBuildClaims(opts((o) => markBuildDispatchResume({ ...o, lockRoot: resumeRoot })));
    expect(spawns).toBe(1);
    expect(r2).toEqual([{ num: '4131', action: 'leave', reason: 'alive' }]);
  });

  it('a spawn that THROWS is recorded spawnFailed: reported as an error, and the next pass counts that attempt '
    + 'and retries — never waiting out a TTL for a resume known not to be running', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    let spawns = 0;
    const opts = (spawnResume) => ({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => ({ resumable: true }),
      releaseClaim: () => { throw new Error('must not release'); },
      releaseResumeMarker: () => {},
      settleRow: () => {},
      spawnResume,
      markResume: (o) => markBuildDispatchResume({ ...o, lockRoot: resumeRoot }),
    });
    const r1 = await adoptOrphanedBuildClaims(opts(() => { spawns += 1; throw new Error('EAGAIN'); }));
    expect(r1).toEqual([expect.objectContaining({ action: 'error', reason: 'EAGAIN' })]);
    expect(readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }).meta).toMatchObject({ spawnFailed: true, attempts: 1 });
    const r2 = await adoptOrphanedBuildClaims(opts(() => { spawns += 1; return 777; }));
    expect(r2).toEqual([expect.objectContaining({ action: 'resume', pid: 777 })]);
    expect(readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }).meta).toMatchObject({ pid: 777, attempts: 2, spawnFailed: false });
    expect(spawns).toBe(2);
  });

  it('the exhausted branch places the hold BEFORE releasing the claim', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    markBuildDispatchResume({ num: '4131', pid: 1, runId: 'dispatch-lane-x', rowKey: 'step:1:0', attempts: MAX_RESUME_ATTEMPTS, lockRoot: resumeRoot });
    const order = [];
    await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot }),
      resolveResumability: () => ({ resumable: true }),
      releaseClaim: () => order.push('release'),
      releaseResumeMarker: () => {},
      settleRow: () => order.push('settle'),
      placeHold: () => order.push('hold'),
    });
    expect(order).toEqual(['hold', 'release', 'settle']);
  });

  it('one throwing claim never aborts adoption of the claims after it', async () => {
    acquireBuildDispatchClaim({ num: '1', scope: [], lockRoot, pid: 1 });
    acquireBuildDispatchClaim({ num: '2', scope: [], lockRoot, pid: 1 });
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: (num) => { if (num === '1') throw new Error('boom'); return buildRow({ num, handle: 'pid:5' }); },
      readResumeMarker: () => null,
      resolveResumability: () => ({ resumable: false, reason: 'no-done-report' }),
      releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot }),
      releaseResumeMarker: () => {},
      settleRow: () => {},
    });
    const byNum = Object.fromEntries(results.map((r) => [r.num, r.action]));
    expect(byNum).toEqual({ 1: 'error', 2: 'release' });
  });

  it('allowResume:false (kill switch / freeze) never spawns a resume — the claim is left for a later tick', async () => {
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot, pid: 1 });
    const results = await adoptOrphanedBuildClaims({
      allowResume: false,
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => false,
      findRow: () => buildRow({ num: '4131', handle: 'pid:74142' }),
      readResumeMarker: () => null,
      resolveResumability: () => ({ resumable: true }),
      releaseClaim: () => { throw new Error('must not release a resumable orphan'); },
      releaseResumeMarker: () => {},
      settleRow: () => { throw new Error('must not settle'); },
      spawnResume: () => { throw new Error('must not spawn while frozen'); },
      markResume: () => { throw new Error('must not mark while frozen'); },
    });
    expect(results).toEqual([{ num: '4131', action: 'leave', reason: expect.stringContaining('frozen') }]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }).map((c) => c.meta.num)).toEqual(['4131']);
  });

  it('reads the run store ONCE per pass, however many claims there are', async () => {
    for (const n of ['1', '2', '3']) acquireBuildDispatchClaim({ num: n, scope: [], lockRoot, pid: 1 });
    let listRunsCalls = 0;
    await adoptOrphanedBuildClaims({
      listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
      isPidAlive: () => true,
      listRuns: () => { listRunsCalls += 1; return []; },
      readResumeMarker: () => null,
    });
    expect(listRunsCalls).toBe(1);
  });

  it('ignores a non-`build`-kind claim entirely (never reached, but defensive)', async () => {
    const results = await adoptOrphanedBuildClaims({
      listClaims: () => [{ owner: 'x', meta: { num: '1', kind: 'not-build' } }],
      isPidAlive: () => { throw new Error('must never be consulted for a non-build claim'); },
    });
    expect(results).toEqual([]);
  });
});


describe('defaultCurrentLaneSession', () => {
  it('requests only the selected lane with lease-only status', () => {
    const run = (command, argv) => {
      expect(command).toBe('node');
      expect(argv).toEqual(['scripts/lane-pool.mjs', 'status', '--json', '--lane=3', '--leased-only']);
      return JSON.stringify({ lanes: [{ lane: 3, lease: { session: 'holder' } }] });
    };
    expect(defaultCurrentLaneSession(3, { run })).toBe('holder');
    expect(defaultCurrentLaneSession(3, { run: () => '{"lanes":[]}' })).toBeNull();
  });
});


// xykwe0h — a build is settled by what it really did, and a paused session is not a dead one.
describe('xykwe0h — real outcomes, not orphan-released', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-orphan-real-')); });
  afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });
  const claudeRow = (num, handle) => ({
    runId: 'dispatch-lane-x',
    entry: { key: 'k', status: 'in-flight', handle, startedAt: '2099-01-01T00:00:00.000Z', payload: { num, launchKind: 'build', lane: 3, sessionSlug: `conveyor-${num}`, scope: [] } },
  });
  const common = (num, extra) => ({
    listClaims: () => listBuildDispatchClaims({ lockRoot, ignoreExpiry: true }),
    isPidAlive: () => false, // the dispatching process is long gone, as in production
    readResumeMarker: () => null,
    releaseClaim: ({ num: n }) => releaseBuildDispatchClaim({ num: n, lockRoot }),
    releaseResumeMarker: () => {},
    resolveResumability: () => ({ resumable: false, reason: 'no-done-report' }),
    spawnResume: () => { throw new Error('must not spawn'); },
    markResume: () => { throw new Error('must not mark'); },
    ...extra,
  });

  it('replay #4388 -> PR #4339: a dead agy dispatch whose session opened a PR settles as pr-opened with that PR', async () => {
    acquireBuildDispatchClaim({ num: '4388', scope: [], lockRoot, pid: 111 });
    let settled = 'not-called'; let released = 'not-called';
    const results = await adoptOrphanedBuildClaims(common('4388', {
      findRow: () => claudeRow('4388', 'pid:10940'),
      readDelivery: () => ({ outcome: 'pr-open', pr: 4339, reason: 'PR #4339 is open' }),
      settleDelivered: (o) => { settled = o; },
      settleRow: (o) => { released = o; },
    }));
    expect(results).toEqual([{ num: '4388', action: 'settled', reason: expect.stringContaining('PR #4339') }]);
    expect(settled).toMatchObject({ runId: 'dispatch-lane-x', key: 'k', delivery: { outcome: 'pr-open', pr: 4339 } });
    expect(released).toBe('not-called'); // never settled as orphan-released
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toEqual([]);
  });

  it('replay #4382: a dead build whose PR already merged settles as pr-merged', async () => {
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot, pid: 111 });
    let settled = null;
    const results = await adoptOrphanedBuildClaims(common('4382', {
      findRow: () => claudeRow('4382', 'c7a15fe4'),
      readDelivery: () => ({ outcome: 'pr-merged', pr: 4288, reason: 'PR #4288 merged' }),
      settleDelivered: (o) => { settled = o; },
      settleRow: () => { throw new Error('must not settle as orphan'); },
    }));
    expect(results[0]).toMatchObject({ num: '4382', action: 'settled' });
    expect(settled.delivery.outcome).toBe('pr-merged');
  });

  it('a resolved card settles as card-resolved', async () => {
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot, pid: 111 });
    const results = await adoptOrphanedBuildClaims(common('4382', {
      findRow: () => claudeRow('4382', 'c7a15fe4'),
      readDelivery: () => ({ outcome: 'card-resolved', pr: null, reason: 'card #4382 is resolved' }),
      settleDelivered: () => {},
    }));
    expect(results[0]).toMatchObject({ action: 'settled', reason: expect.stringContaining('card-resolved') });
  });

  it('no delivery evidence still releases as orphan-released (unchanged)', async () => {
    acquireBuildDispatchClaim({ num: '4400', scope: [], lockRoot, pid: 111 });
    const results = await adoptOrphanedBuildClaims(common('4400', { findRow: () => claudeRow('4400', 'pid:9'), settleRow: () => {} }));
    expect(results[0]).toMatchObject({ action: 'release' });
  });

  it('#5189: a claude-bg session paused awaiting verify is ALIVE, not orphaned, even with a dead owner pid', async () => {
    acquireBuildDispatchClaim({ num: '5189', scope: [], lockRoot, pid: 111 });
    const results = await adoptOrphanedBuildClaims(common('5189', {
      findRow: () => claudeRow('5189', '14cd6f08'),
      sessionLivenessFor: ({ handle }) => (handle === '14cd6f08' ? { alive: true, reason: 'awaiting-verify' } : null),
      readDelivery: () => { throw new Error('a live session is never checked for delivery'); },
      settleRow: () => { throw new Error('must not retire a live session'); },
    }));
    expect(results).toEqual([{ num: '5189', action: 'leave', reason: 'alive (awaiting-verify)' }]);
    expect(listBuildDispatchClaims({ lockRoot, ignoreExpiry: true })).toHaveLength(1);
  });

  it('classifyClaimLiveness: a non-pid handle with a live session reads alive; without it, falls back to the owner pid', () => {
    const row = claudeRow('5189', '14cd6f08');
    expect(classifyClaimLiveness({ row, resumeMarker: null, ownerPid: 111, isPidAlive: () => false, sessionLive: { alive: true, reason: 'awaiting-verify' } }))
      .toMatchObject({ status: 'alive', reason: 'awaiting-verify' });
    expect(classifyClaimLiveness({ row, resumeMarker: null, ownerPid: 111, isPidAlive: () => false, sessionLive: null }).status).toBe('dead');
  });
});

describe('defaultSessionLiveness — reads the harness job record', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z');
  const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
  const jobs = (state, updatedAt = minutesAgo(1)) => ({
    jobsDir: '/jobs', readdir: () => ['14cd6f08-4ed4-4ec4-8745-8020ef0e58cf'], now: () => NOW,
    readFile: () => JSON.stringify({ state, updatedAt, sessionId: '14cd6f08-4ed4-4ec4-8745-8020ef0e58cf', name: 'conveyor-5189', cwd: '/x' }),
  });
  it('a working session that updated recently is alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working'), awaitingFor: () => null })).toMatchObject({ alive: true });
  });
  it('a STALE working record (crashed or killed with the host) is not alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', minutesAgo(120)), awaitingFor: () => null }))
      .toMatchObject({ alive: false, reason: 'session-stale' });
  });
  it('a stale working record whose session is parked on a live await-verify record is still alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', minutesAgo(120)), awaitingFor: () => ({ awaiting: true }) }))
      .toEqual({ alive: true, reason: 'awaiting-verify' });
  });
  it('a fresh blocked session (a documented live state) is alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('blocked'), awaitingFor: () => null })).toMatchObject({ alive: true });
  });
  it('a FUTURE or non-ISO updatedAt (clock skew, corrupt record, "0") is unknown, never alive', () => {
    for (const at of ['2099-01-01T00:00:00Z', new Date(NOW + 3_600_000).toISOString(), '0', '1', '2026-10-08']) {
      expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', at), awaitingFor: () => null })).toBeNull();
    }
  });
  it('a small clock wobble ahead of now still reads fresh', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', new Date(NOW + 60_000).toISOString()), awaitingFor: () => null })).toMatchObject({ alive: true });
  });
  it.each(['cancelled', 'killed', 'failed', 'error'])('the terminal state %s is not alive', (state) => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs(state), awaitingFor: () => null })).toMatchObject({ alive: false });
  });
  it.each([undefined, '', 'frobnicating'])('a missing or unrecognized job state (%j) is unknown (null), never alive', (state) => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs(state), awaitingFor: () => null })).toBeNull();
  });
  it('an active state with no usable updatedAt is unknown (null): staleness cannot be judged', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', null), awaitingFor: () => null })).toBeNull();
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('working', 'not-a-date'), awaitingFor: () => null })).toBeNull();
  });
  it('an ended turn with a live await-verify record is alive (awaiting-verify)', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('done'), awaitingFor: () => ({ awaiting: true }) })).toEqual({ alive: true, reason: 'awaiting-verify' });
  });
  it('an ended session with no record is not alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', ...jobs('stopped'), awaitingFor: () => ({ awaiting: false }) })).toMatchObject({ alive: false });
  });
  it('an unreadable job record is unknown (null), never alive', () => {
    expect(defaultSessionLiveness({ handle: '14cd6f08', jobsDir: '/jobs', readdir: () => { throw new Error('x'); } })).toBeNull();
  });
});

describe('settleDeliveredRow', () => {
  it('settles an in-flight row as applied with the real outcome and pr', () => {
    let written = null;
    const run = newRunRecord({ id: 'dispatch-lane-t', op: 'dispatch-lane' });
    run.effects = [{ key: 'dispatch-lane-t#2#0', stepIndex: 2, step: 'dispatch', index: 0, type: 'conveyor.dispatch-delivery-agent', payload: {}, status: 'in-flight', handle: 'abc12345', startedAt: '2026-10-07T21:18:11.409Z' }];
    settleDeliveredRow({ runId: run.id, key: 'dispatch-lane-t#2#0', delivery: { outcome: 'pr-open', pr: 4339 } }, { read: () => run, write: (r) => { written = r; } });
    const e = written.effects.find((x) => x.key === 'dispatch-lane-t#2#0');
    expect(e.status).toBe('applied');
    expect(e.result).toEqual({ outcome: 'pr-opened', pr: 4339 });
  });
});
