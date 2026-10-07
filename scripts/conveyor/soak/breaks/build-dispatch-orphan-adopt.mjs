/**
 * @file breaks/build-dispatch-orphan-adopt.mjs — #4131/#4382 build-orphan-adopt.
 *
 * LIVE incident, 2026-09-29: a build's detached delivery wrapper (`deliver-item-run.mjs`) died with NONE of
 * `build-dispatch-daemon.mjs#doneWhy`'s three claim-retirement signals ever becoming true — no PR opened, the
 * item still sitting in the cleared queue, no settled run-store row (only the wrapper's own exit path ever
 * settles one, and it never ran). The claim sat "in flight" forever, occupying a builder slot, while the
 * agent's own finished work — a real commit, already pushed into the lane — was silently abandoned.
 *
 * SIX real shapes, all reproduced in one run (the sixth, #4688, is listed after the five below):
 *   - #4131-A: an in-flight row, dead pid, report says done, lane still has the commit → RESUME.
 *   - #4382: an in-flight row, dead pid, nothing resumable at all → RELEASE, no hold.
 *   - #4400 (PR #2921 review): a LIVE re-dispatch (its own pid alive) whose item still carries a STALE resume
 *     marker bound to an OLDER attempt (a dead pid) → must be LEFT; the stale marker must never make a live
 *     build look dead.
 *   - #4468 (the ACTUAL live #4131 shape): the wrapper settled `applied` as `{outcome:'pr-opened', pr:null}` —
 *     no in-flight row at all to find, and the lane has since been recycled to a DIFFERENT session → RELEASE
 *     (never resumed off a lane that belongs to someone else now).
 *   - #4469 (the ACTUAL live #4382 shape): NO run-store row was ever found at all (killed before it ever
 *     reached `in-flight`) — only the claim's own dead OWNER pid says anything → RELEASE.
 *   - #4688 (live 2026-10-06): dead owner pid, and the only run row is an OLDER attempt's settled row (it
 *     started BEFORE this claim) → the older row is ignored, the owner pid decides → RELEASE.
 *   Fixture ordering matters: every row a claim legitimately owns starts AFTER that claim (a row that predates
 *   its claim is, by definition, an older attempt's — `classifyClaimLiveness`'s `claimedAt` guard).
 *
 * Fix: `scripts/conveyor/build-dispatch-orphan-adopt.mjs#adoptOrphanedBuildClaims`, wired into
 * `skills-src/conveyor/build-dispatch-daemon.mjs`'s own live tick (`effects.adoptOrphans`, called before the
 * tick's own claim-retirement read).
 *
 * `adoptOrphanedBuildClaims()` runs for real over REAL claims/run-store rows/git lanes/delivery reports; only
 * the actual detached resume SPAWN is faked (this soak sandbox cannot run a real agent) and the lane-pool
 * reads (lease-currency + path lookup) are short-circuited to the fixture lanes (no real `lane-pool.mjs` state
 * on this host to shell out to) — every other read/write in the pass is the genuine on-disk primitive.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/** A real, dead pid — spawned and WAITED OUT (never guessed at, never a hardcoded huge number). */
function realDeadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  if (!Number.isInteger(r.pid) || r.pid <= 0) throw new Error('soak fixture: could not mint a real dead pid');
  return r.pid;
}

/** A minimal, real git lane in the SHAPE a real pool lane has (PR #2921 review — the old fixture committed on a
 *  side branch, which hid that a real lane's working branch IS its local `main`): `origin/main` at one base
 *  commit, the local `main` checked out on it, and — when `ahead` — ONE build commit on that same local `main`
 *  carrying the agent's work plus the wrapper's own claim edit to the item's backlog card. */
function makeLane({ ahead, num = '4131' }) {
  const lane = mkdtempSync(join(tmpdir(), 'soak-orphan-lane-'));
  const git = (args) => execFileSync('git', args, { cwd: lane, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'soak@test']);
  git(['config', 'user.name', 'soak']);
  mkdirSync(join(lane, 'backlog'));
  writeFileSync(join(lane, 'README.md'), 'base\n');
  writeFileSync(join(lane, 'backlog', `${num}-orphan-thing.md`), 'status: open\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  if (ahead) {
    writeFileSync(join(lane, 'agent-work.txt'), 'the agent\'s own finished work\n');
    writeFileSync(join(lane, 'backlog', `${num}-orphan-thing.md`), 'status: active\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', `WE #${num}: delivery build`]);
  }
  return lane;
}

export default {
  id: 'build-dispatch-orphan-adopt',
  title: 'a build-dispatch claim whose detached wrapper died was never retired or resumed — permanently stuck '
    + 'occupying a builder slot, with the agent\'s finished work abandoned',
  card: 'build-orphan-adopt (#4131/#4382, blocker bug 2026-09-29)',
  fixedBy: {
    sha: 'HEAD', where: 'lane/build-orphan-adopt',
    paths: ['scripts/conveyor/build-dispatch-orphan-adopt.mjs', 'skills-src/conveyor/build-dispatch-daemon.mjs'],
  },
  fixPresent(root) {
    const modulePath = join(root, 'scripts/conveyor/build-dispatch-orphan-adopt.mjs');
    const daemonPath = join(root, 'skills-src/conveyor/build-dispatch-daemon.mjs');
    return existsSync(modulePath) && existsSync(daemonPath) && /adoptOrphans/.test(readFileSync(daemonPath, 'utf8'));
  },
  async run({ log } = {}) {
    const violations = [];
    const {
      adoptOrphanedBuildClaims, checkResumable, findLatestBuildRow,
    } = await import(resolve(REPO_ROOT, 'scripts/conveyor/build-dispatch-orphan-adopt.mjs'));
    const {
      acquireBuildDispatchClaim, releaseBuildDispatchClaim, listBuildDispatchClaims,
      markBuildDispatchResume, readBuildDispatchResume, releaseBuildDispatchResume,
    } = await import(resolve(REPO_ROOT, 'scripts/conveyor/build-dispatch-claim.mjs'));
    const { createFileRunStore, newRunRecord, newRunId } = await import(resolve(REPO_ROOT, 'scripts/operations/run-store.mjs'));
    const { resolveInFlight } = await import(resolve(REPO_ROOT, 'scripts/operations/effect-executor.mjs'));
    const { DISPATCH_EFFECT } = await import(resolve(REPO_ROOT, 'scripts/operations/dispatch-lane.mjs'));
    const {
      writeDeliveryReport, newDeliveryReport, applyDeliveryUpdate, resolveDeliveryReportsDir,
    } = await import(resolve(REPO_ROOT, 'scripts/operations/delivery-report-store.mjs'));

    const claimRoot = mkdtempSync(join(tmpdir(), 'soak-orphan-claims-'));
    const resumeRoot = mkdtempSync(join(tmpdir(), 'soak-orphan-resumes-'));
    const runsDir = mkdtempSync(join(tmpdir(), 'soak-orphan-runs-'));
    const store = createFileRunStore(runsDir);

    /** Write a real in-flight `build` dispatch effect for `num`, handle `pid:<deadPid>`. */
    function writeInFlightRow(num, { lane, sessionSlug, deadPid }) {
      const runId = newRunId('dispatch-lane');
      const record = newRunRecord({ id: runId, op: 'dispatch-lane', input: {} });
      record.effects.push({
        key: 'step:1:0', type: DISPATCH_EFFECT, stepIndex: 1, index: 0, status: 'in-flight',
        handle: `pid:${deadPid}`, startedAt: new Date().toISOString(), // written AFTER its claim, as in production (see ROW_OLDER_THAN_CLAIM)
        payload: { num, launchKind: 'build', lane, sessionSlug, scope: [] },
      });
      store.write(record);
      return runId;
    }

    /** Write a real SETTLED (`applied`) `build` dispatch effect for `num` — the exact #4131 live shape: the
     *  wrapper's own exit path settled it as `pr-opened`, but the PR number came back null. No `handle`/pid at
     *  all is relevant here — settled rows are read by `outcome`/`pr`, never probed for liveness. */
    function writeSettledPrOpenedNullRow(num, { lane, sessionSlug }) {
      const runId = newRunId('dispatch-lane');
      const record = newRunRecord({ id: runId, op: 'dispatch-lane', input: {} });
      record.effects.push({
        key: 'step:1:0', type: DISPATCH_EFFECT, stepIndex: 1, index: 0, status: 'applied',
        handle: null, startedAt: new Date().toISOString(), // written AFTER its claim (see ROW_OLDER_THAN_CLAIM)
        result: { outcome: 'pr-opened', pr: null, park: 'review:pending' },
        payload: { num, launchKind: 'build', lane, sessionSlug, scope: [] },
      });
      store.write(record);
      return runId;
    }

    /** ROW_OLDER_THAN_CLAIM — the #4688 live shape: a SETTLED row from an OLDER attempt (started an hour BEFORE
     *  the current claim was taken). A claim only ever answers for rows its own dispatch wrote, so such a row
     *  is ignored and the claim's own dead owner pid decides. (The fixtures above deliberately start their rows
     *  AFTER their claim — a row predating its own claim is an older attempt's, not that claim's.) */
    function writeOlderSettledRow(num, { lane, sessionSlug }) {
      const runId = newRunId('dispatch-lane');
      const record = newRunRecord({ id: runId, op: 'dispatch-lane', input: {} });
      record.effects.push({
        key: 'step:1:0', type: DISPATCH_EFFECT, stepIndex: 1, index: 0, status: 'failed',
        handle: null, startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        result: { outcome: 'gate-red' },
        payload: { num, launchKind: 'build', lane, sessionSlug, scope: [] },
      });
      store.write(record);
      return runId;
    }

    function settleRow({ runId, key }) {
      if (!runId || !key) return; // #4469 shape — no row was ever found; a clean no-op, same as the real one.
      const run = store.read(runId);
      const entry = (run.effects || []).find((e) => e.key === key);
      if (!entry || entry.status !== 'in-flight') return;
      store.write(resolveInFlight(run, key, { status: 'failed', result: { outcome: 'orphan-released' } }));
    }

    const deadPid = realDeadPid();

    // ── #4131-A shape: an IN-FLIGHT row, dead pid, report says done, lane still has the commit → RESUME ──────
    const resumableLane = makeLane({ ahead: true, num: '4131' });
    acquireBuildDispatchClaim({ num: '4131', scope: [], lockRoot: claimRoot });
    const rowA = writeInFlightRow('4131', { lane: 9, sessionSlug: 'conveyor-4131', deadPid });
    // The agent's report is written AFTER its dispatch row started (production order; `checkResumable` refuses a
    // report that predates the dispatch as a prior attempt's — `report-predates-dispatch`).
    writeDeliveryReport(
      applyDeliveryUpdate(newDeliveryReport({ session: 'conveyor-4131', item: '4131' }), {
        status: 'done', outcome: 'done', filesTouched: ['agent-work.txt'],
      }),
      resolveDeliveryReportsDir(resumableLane),
    );
    let spawnedResumeWith = null;

    // ── #4382 shape: an IN-FLIGHT row, dead pid, nothing resumable at all → RELEASE, no hold ─────────────────
    const emptyLane = makeLane({ ahead: false, num: '4382' });
    acquireBuildDispatchClaim({ num: '4382', scope: [], lockRoot: claimRoot });
    const rowB = writeInFlightRow('4382', { lane: 11, sessionSlug: 'conveyor-4382', deadPid });

    // ── #4400 shape (PR #2921 review): a LIVE re-dispatch whose item still carries a STALE resume marker
    // (bound to an OLDER attempt, dead pid) → must be LEFT; the stale marker must never make a live build
    // look dead. ──────────────────────────────────────────────────────────────────────────────────────────
    acquireBuildDispatchClaim({ num: '4400', scope: [], lockRoot: claimRoot });
    const rowC = writeInFlightRow('4400', { lane: 11, sessionSlug: 'conveyor-4400', deadPid: process.pid }); // this soak process: alive
    markBuildDispatchResume({ num: '4400', pid: deadPid, runId: 'dispatch-lane-OLDER-ATTEMPT', rowKey: 'step:1:0', lockRoot: resumeRoot });

    // ── #4468 shape (the ACTUAL live #4131): SETTLED `pr-opened` with a NULL pr, lane already recycled to a
    // DIFFERENT session → RELEASE (the lane-lease-currency check refuses to trust a lane that has moved on —
    // see `checkResumable`'s own docblock). This is the exact gap `findLatestBuildRow` closed: the OLD
    // in-flight-only lookup never even saw this row at all. ───────────────────────────────────────────────
    const recycledLane = makeLane({ ahead: true, num: '4468' }); // has SOME commit, but it belongs to whoever holds it NOW.
    acquireBuildDispatchClaim({ num: '4468', scope: [], lockRoot: claimRoot });
    const rowD = writeSettledPrOpenedNullRow('4468', { lane: 30, sessionSlug: 'conveyor-4468' });

    // ── #4469 shape (the ACTUAL live #4382): NO run-store row was ever found at all (killed before it ever
    // reached `in-flight`) — only the claim's own OWNER pid (dead) says anything at all → RELEASE. ─────────
    acquireBuildDispatchClaim({ num: '4469', scope: [], lockRoot: claimRoot, pid: deadPid });

    // ── #4688 shape (live 2026-10-06): the claim's owner pid is dead and the ONLY run row is an OLDER attempt's
    // settled row (started an hour before this claim) → that row must NOT answer for the new claim → RELEASE
    // (was `settled-elsewhere` → held for the full 240-min TTL, pinning the builder slot). ─────────────────────
    acquireBuildDispatchClaim({ num: '4688', scope: [], lockRoot: claimRoot, pid: deadPid });
    const rowE = writeOlderSettledRow('4688', { lane: 11, sessionSlug: 'conveyor-4688' });

    const laneByLaneNum = { 9: resumableLane, 11: emptyLane, 30: recycledLane };
    // The lane-lease-currency check ({@link checkResumable}'s own safety fix) needs to see #4131's lane (9) as
    // STILL leased under its own matching session — this soak sandbox has no real lane-pool state, so the
    // read is faked to the exact shape a real, still-current lease would answer. Lane 30 is faked as
    // currently leased to a DIFFERENT session (`conveyor-9999`) — a later item that recycled it, exactly as
    // #4131's own real lane (8) was recycled twice before this fix landed.
    const sessionByLaneNum = { 9: 'conveyor-4131', 11: 'conveyor-4382', 30: 'conveyor-9999' };
    const rowByNum = { 4131: rowA, 4382: rowB, 4400: rowC, 4468: rowD, 4688: rowE };

    let results;
    try {
      results = await adoptOrphanedBuildClaims({
        listClaims: () => listBuildDispatchClaims({ lockRoot: claimRoot, ignoreExpiry: true }),
        findRow: (num) => (rowByNum[num] ? findLatestBuildRow([{ id: rowByNum[num], record: store.read(rowByNum[num]) }], num) : null),
        readResumeMarker: (num) => readBuildDispatchResume({ num, lockRoot: resumeRoot }),
        // REAL checkResumable — real `tryReadDeliveryReport`/`laneHasCommitAhead` (real git), only the
        // lane-pool reads (lease-currency + path lookup) are short-circuited (no real lane-pool state on this
        // host).
        resolveResumability: (o) => checkResumable({
          ...o,
          currentLaneSession: () => sessionByLaneNum[Number(o.lane)],
          resolveLane: () => laneByLaneNum[Number(o.lane)],
        }),
        releaseClaim: ({ num }) => releaseBuildDispatchClaim({ num, lockRoot: claimRoot }),
        releaseResumeMarker: ({ num }) => releaseBuildDispatchResume({ num, lockRoot: resumeRoot }),
        settleRow,
        spawnResume: (o) => { spawnedResumeWith = o; return 424242; }, // FAKE — never a real agent in a soak sandbox.
        markResume: (o) => markBuildDispatchResume({ ...o, lockRoot: resumeRoot }),
      });
    } catch (e) {
      violations.push({ invariant: 'crash', detail: String(e?.stack || e) });
      return { violations };
    }
    log?.(JSON.stringify(results));

    const byNum = Object.fromEntries(results.map((r) => [r.num, r]));
    const claimsAfter = listBuildDispatchClaims({ lockRoot: claimRoot, ignoreExpiry: true }).map((c) => c.meta.num);

    // #4131 — RESUMED, never released, never left stuck.
    if (byNum['4131']?.action !== 'resume') {
      violations.push({ invariant: 'resume-not-triggered', detail: `#4131 (resumable) got action ${JSON.stringify(byNum['4131'])}, expected 'resume'` });
    }
    if (!spawnedResumeWith || String(spawnedResumeWith.sessionSlug) !== 'conveyor-4131') {
      violations.push({ invariant: 'resume-wrong-session', detail: `resume spawned with ${JSON.stringify(spawnedResumeWith)}` });
    }
    if (!claimsAfter.includes('4131')) {
      violations.push({ invariant: 'claim-lost-during-resume', detail: '#4131\'s claim must stay held while its resume runs — it was released instead' });
    }
    const markerA = readBuildDispatchResume({ num: '4131', lockRoot: resumeRoot });
    if (!markerA) {
      violations.push({ invariant: 'resume-not-marked', detail: 'no resume marker recorded for #4131 after a resume dispatch' });
    } else if (markerA.meta?.runId !== rowA || markerA.meta?.rowKey !== 'step:1:0') {
      violations.push({ invariant: 'resume-marker-unbound', detail: `#4131's resume marker is not bound to its row: ${JSON.stringify(markerA.meta)}` });
    }
    if (!spawnedResumeWith || spawnedResumeWith.runId !== rowA || spawnedResumeWith.effectKey !== 'step:1:0') {
      violations.push({ invariant: 'resume-cannot-settle-row', detail: `resume not handed the original row's run-id/effect-key: ${JSON.stringify(spawnedResumeWith)}` });
    }

    // #4382 — THE ACTUAL BUG THIS CARD FIXES: RELEASED (never stuck forever occupying a builder slot).
    if (byNum['4382']?.action !== 'release') {
      violations.push({ invariant: 'release-not-triggered', detail: `#4382 (nothing resumable) got action ${JSON.stringify(byNum['4382'])}, expected 'release'` });
    }
    if (claimsAfter.includes('4382')) {
      violations.push({ invariant: 'claim-stuck-forever', detail: '#4382\'s claim is STILL held after adoption — this is the exact live bug: a dead-wrapper claim never retired, permanently occupying a builder slot' });
    }

    // #4400 (PR #2921 review) — a stale marker must never get a LIVE build released.
    if (byNum['4400']?.action !== 'leave' || !claimsAfter.includes('4400')) {
      violations.push({ invariant: 'stale-marker-killed-live-build', detail: `#4400 (live re-dispatch, stale marker) got ${JSON.stringify(byNum['4400'])}; claim held: ${claimsAfter.includes('4400')}` });
    }

    // #4468 (the ACTUAL live #4131 shape) — settled `pr-opened` with a null pr, lane already recycled to a
    // DIFFERENT session → RELEASED, never resumed off a lane that belongs to someone else now.
    if (byNum['4468']?.action !== 'release') {
      violations.push({ invariant: 'settled-null-pr-not-released', detail: `#4468 (settled pr-opened, no real pr, lane recycled) got action ${JSON.stringify(byNum['4468'])}, expected 'release'` });
    }
    if (claimsAfter.includes('4468')) {
      violations.push({ invariant: 'settled-null-pr-claim-stuck', detail: '#4468\'s claim is STILL held — the exact #4131 live shape (a settled pr-opened outcome with no confirmed pr) must never be left stuck just because doneWhy defers pr-opened settles to a PR that does not exist' });
    }

    // #4469 (the ACTUAL live #4382 shape) — NO run-store row at all, only the claim's own dead owner pid →
    // RELEASED — the exact gap the original (in-flight-only, no-owner-pid-fallback) version of this module left
    // open.
    if (byNum['4469']?.action !== 'release') {
      violations.push({ invariant: 'no-record-dead-owner-not-released', detail: `#4469 (no run-store row at all, dead owner pid) got action ${JSON.stringify(byNum['4469'])}, expected 'release'` });
    }
    if (claimsAfter.includes('4469')) {
      violations.push({ invariant: 'no-record-dead-owner-claim-stuck', detail: '#4469\'s claim is STILL held — this is the exact #4382 live shape' });
    }

    // #4688 (live 2026-10-06) — an OLDER attempt's settled row must never keep a dead-owner claim alive.
    if (byNum['4688']?.action !== 'release') {
      violations.push({ invariant: 'older-row-pinned-claim', detail: `#4688 (dead owner pid, only an OLDER settled row) got action ${JSON.stringify(byNum['4688'])}, expected 'release'` });
    }
    if (claimsAfter.includes('4688')) {
      violations.push({ invariant: 'older-row-claim-stuck', detail: '#4688\'s claim is STILL held — the exact live shape: an older attempt\'s settled row pinned a dead daemon\'s claim for the full TTL' });
    }

    // cleanup — best-effort, never masks a violation already recorded.
    for (const dir of [claimRoot, resumeRoot, runsDir, resumableLane, emptyLane, recycledLane]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    return { violations, results };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
