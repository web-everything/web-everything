/**
 * @file scripts/__tests__/lane-pool-release-ownership.test.mjs
 * @description Proof of the #2452 Gap 2 fix: `cmdRelease` used to key ownership off `defaultSession()`
 *   (`--session` / `LANE_SESSION` / else `${hostname()}:${process.ppid}`), NOT the durable `ownerSession`
 *   (`CLAUDE_CODE_SESSION_ID`) signal `isForeignLease` adopted in #2367. Since a shell's `ppid` differs across
 *   separate invocations, the very session that ACQUIRED a lease read as "not yours" on a later `release` call
 *   with no explicit `--session`/`LANE_SESSION` — observed live 2026-07-12 (lane-20, lane-21) — and had to pass
 *   `--force`. This spawns the real CLI twice as genuinely SEPARATE processes (acquire, then release, with no
 *   shared `--session`/`LANE_SESSION`) but the SAME `CLAUDE_CODE_SESSION_ID` env var, matching the real scenario:
 *   one interactive session, driving `acquire` then `release` through separate Bash-tool invocations.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

import { isDeliveredLease, laneAuthoredSince } from '../lib/lane-lease.mjs';

describe('isDeliveredLease', () => {
  const delivered = { porcelain: '', headIsAncestorOfUpstream: true, headCommitMs: 2000, acquiredAtMs: 1000, authoredSinceAcquire: true };
  it('accepts a clean, landed commit made after acquisition (including equality)', () => {
    expect(isDeliveredLease(delivered)).toBe(true);
    expect(isDeliveredLease({ ...delivered, headCommitMs: 1000 })).toBe(true);
  });
  it.each([
    { porcelain: ' M file.txt' },
    { headIsAncestorOfUpstream: false },
    { headCommitMs: 999 },
    { porcelain: null },
    { headCommitMs: NaN },
    { acquiredAtMs: NaN },
    // a clean lane that only synced to a newer main has a HEAD newer than acquiredAt but authored nothing
    { authoredSinceAcquire: false },
    { authoredSinceAcquire: undefined },
  ])('refuses live or unproven work: %j', (change) => {
    expect(isDeliveredLease({ ...delivered, ...change })).toBe(false);
  });
});

describe('laneAuthoredSince', () => {
  const at = (s, subject, sha = 'abc123') => `${s}\t${sha}\t${subject}`;
  it('counts only a commit that LANDED — a WIP commit reset away does not make a live lane releasable', () => {
    const lines = [at(2, 'commit: wip', 'wip111'), at(3, 'reset: moving to origin/main', 'main222')];
    expect(laneAuthoredSince(lines, 1000, (sha) => sha === 'main222')).toBe(false);
    expect(laneAuthoredSince(lines, 1000, (sha) => sha === 'wip111')).toBe(true);
  });
  it('counts a commit / amend / cherry-pick the lane made at or after acquisition', () => {
    expect(laneAuthoredSince([at(2, 'commit: work')], 1000)).toBe(true);
    expect(laneAuthoredSince([at(1, 'commit (amend): work')], 1000)).toBe(true);
    expect(laneAuthoredSince([at(3, 'cherry-pick: work')], 1000)).toBe(true);
  });
  it.each([
    [[at(2, 'reset: moving to origin/main')]],
    [[at(2, 'checkout: moving from main to main')]],
    [[at(2, 'merge origin/main: Fast-forward')]],
    [[at(2, 'pull: Fast-forward')]],
    [[at(0, 'commit: made before the lease was taken')]],
    [[]],
    [undefined],
  ])('does not count a sync or an older commit: %j', (lines) => {
    expect(laneAuthoredSince(lines, 1000)).toBe(false);
  });
  it('is false when the acquisition time is unknown', () => {
    expect(laneAuthoredSince([at(2, 'commit: work')], NaN)).toBe(false);
  });
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot;

// Runs the CLI as a genuinely separate process each call — never passing --session/LANE_SESSION — so
// `defaultSession()` falls back to `${hostname()}:${process.ppid}`, which necessarily differs between this
// call and the next (each `spawnSync` is its own process, so `process.ppid` as seen from inside node differs
// run to run). `ownerSessionId` stands in for `CLAUDE_CODE_SESSION_ID` — stable across both calls, exactly the
// signal one interactive Claude Code session's separate Bash-tool invocations share.
function runPool(args, ownerSessionId) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the
  // real default pool root (~/workspace/.lanes), colliding with any other lane pool of the same --name.
  const env = { ...process.env, LANE_POOL_ROOT: poolRoot };
  delete env.LANE_SESSION;
  if (ownerSessionId !== undefined) env.CLAUDE_CODE_SESSION_ID = ownerSessionId;
  else delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-release-owner-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-release-owner-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=releaseowner', '--branch=trunk', '--no-install'];

describe('lane-pool release ownership via ownerSession (#2452 Gap 2)', () => {
  // Both `acquire` and `release` below pass an EXPLICIT, DELIBERATELY-DIFFERENT `--session=` string
  // (`acquired-as-host-A` vs. `released-as-host-B`) — standing in for `defaultSession()`'s real
  // `${hostname()}:${process.ppid}` fallback, which genuinely differs between two separate shell
  // invocations (the exact bug: acquire's pid is long gone by the time release runs). Without this
  // explicit mismatch, both calls here would spawn from the SAME vitest worker process and so share
  // one `process.ppid` — accidentally passing via the trivial exact-session-match path and never
  // exercising the `ownerSession` fallback this test exists to prove.
  it('the ACQUIRING session releases its own lease WITHOUT --force, via ownerSession alone (session strings deliberately differ)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()], 'sess-uuid-mine');
    expect(provision.code).toBe(0);

    const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=acquired-as-host-A'], 'sess-uuid-mine');
    expect(acquire.code).toBe(0);

    // #2452 review — `--json` is REQUIRED for this to assert anything: `log()` writes to stderr, so without
    // it stdout is empty. The original assertion sat behind a truthiness check on stdout, which was therefore
    // always false — the test could (and did) pass while releasing zero lanes. Ask for the machine-readable
    // result and assert the release count unconditionally.
    const release = runPool(['release', '--lane=1', ...poolArgs(), '--session=released-as-host-B', '--json'], 'sess-uuid-mine');
    expect(release.code).toBe(0);
    expect(release.out + release.err).not.toMatch(/not yours/);
    expect(release.out.trim()).not.toBe('');
    expect(JSON.parse(release.out).released).toBe(1);
  });

  it('a DIFFERENT ownerSession is still refused without --force (a genuinely foreign lease stays protected)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()], 'sess-uuid-A');
    expect(provision.code).toBe(0);

    const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=acquired-as-host-A'], 'sess-uuid-A');
    expect(acquire.code).toBe(0);

    const release = runPool(['release', '--lane=1', ...poolArgs(), '--session=released-as-host-B'], 'sess-uuid-B');
    expect(release.code).toBe(0); // release doesn't hard-fail; it logs + skips
    expect(release.out + release.err).toMatch(/not yours/);

    const forced = runPool(['release', '--lane=1', '--force', ...poolArgs(), '--session=released-as-host-B'], 'sess-uuid-B');
    expect(forced.code).toBe(0);
    expect(forced.out + forced.err).not.toMatch(/not yours/);
  });

  // #2452 review — the SWEEP blast radius. `ownerSession` is stamped on EVERY lease, and sibling conveyor
  // lanes (`conveyor-delivery` / `conveyor-fix` / …) are UNMARKED yet share one `ownerSession`, because #2413
  // says a spawned subagent inherits the parent id verbatim. Before this fix, an un-forced `release --all` from
  // any of those siblings dropped ALL of their live leases — after which a fresh `acquire` runs
  // `checkout -B --force` + `clean -fd` on a clone another sub-flow was still working in. The sweep must stay
  // on the exact-`session` rule; only naming the lane may use the `ownerSession` fallback.
  it('`release --all` does NOT drop a sibling lease that merely shares the caller\'s CLAUDE_CODE_SESSION_ID', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()], 'sess-uuid-shared');
    expect(provision.code).toBe(0);

    // the sibling acquires under the shared session id, with its own host:pid-style `session` string
    const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=sibling-host-A'], 'sess-uuid-shared');
    expect(acquire.code).toBe(0);

    // a DIFFERENT sub-flow of the same session sweeps: same CLAUDE_CODE_SESSION_ID, different `session` string
    const sweep = runPool(['release', '--all', ...poolArgs(), '--session=sweeper-host-B', '--json'], 'sess-uuid-shared');
    expect(sweep.code).toBe(0);
    expect(JSON.parse(sweep.out).released).toBe(0);
    expect(sweep.out + sweep.err).toMatch(/not yours/);
    // …and the message points at the escape hatch rather than just refusing
    expect(sweep.out + sweep.err).toMatch(/release --lane=1/);

    // the lease really is still held — a targeted release still finds it there to drop
    const targeted = runPool(['release', '--lane=1', ...poolArgs(), '--session=sweeper-host-B', '--json'], 'sess-uuid-shared');
    expect(targeted.code).toBe(0);
    expect(JSON.parse(targeted.out).released).toBe(1);
  });

  it('`release --all` still releases a lease whose exact `session` string matches the caller', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()], 'sess-uuid-shared');
    expect(provision.code).toBe(0);
    const acquire = runPool(['acquire', ...poolArgs(), '--no-reset', '--session=same-slug'], 'sess-uuid-shared');
    expect(acquire.code).toBe(0);

    const sweep = runPool(['release', '--all', ...poolArgs(), '--session=same-slug', '--json'], 'sess-uuid-shared');
    expect(sweep.code).toBe(0);
    expect(JSON.parse(sweep.out).released).toBe(1);
  });
});

// ── #2997 — the TARGETED release hole #2452's `targeted` gate did not close ──────────────────────────────
//
// THE LIVE OCCURRENCE (2026-08-14, ordinary delivery work, no probe and no override flag): a subagent finished
// its task and ran `lane-pool.mjs release --lane=5` intending to drop its OWN lease
// (`Mac:39367 file-memory-rewrite-gap`). It released a DIFFERENT concurrent holder's
// (`Mac:39423 review-1222-r2`) and the pool accepted it, because both leases carried the same parent
// `CLAUDE_CODE_SESSION_ID` and the ownership check resolved to "same session, therefore mine". Nothing was lost
// only because that holder had already finished — a released lane is immediately re-issuable and the next
// `acquire` runs `checkout -B --force` + `clean -fd` on it. So `release` alone is a data-loss path, and a fix
// that only guarded destructive git ops would not have closed it.
//
// #2452 saw the mechanism and gated the `ownerSession` fallback behind `targeted`. But naming a lane only
// proves the caller MEANT that lane, never that it HOLDS it — and this release named one.
describe('lane-pool #2997 — a TARGETED release of a CONTESTED lease needs the minted holder slug', () => {
  const acquireTwoSiblings = () => {
    expect(runPool(['provision', '--count=2', ...poolArgs()], 'sess-uuid-shared').code).toBe(0);
    // Two ordinary subagents of ONE session, each acquiring its own lane — the default shape of a delivery
    // session, and the shape #2413's `workflowLane` marker never covers (nothing here passes that purpose).
    const a = runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=file-memory-rewrite-gap', '--json'], 'sess-uuid-shared');
    const b = runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=review-1222-r2', '--json'], 'sess-uuid-shared');
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    return { a: JSON.parse(a.out), b: JSON.parse(b.out) };
  };

  it('EVERY acquire now mints a per-holder slug and hands it to the acquirer (#2997)', () => {
    const { a, b } = acquireTwoSiblings();
    expect(a.holder).toBeTruthy();
    expect(b.holder).toBeTruthy();
    expect(a.holder).not.toBe(b.holder); // the one signal ownerSession structurally cannot provide
    expect(a.holder).toMatch(/^file-memory-rewrite-gap-lane-\d+-[0-9a-f]{8}$/);
  });

  it('THE INCIDENT: a sibling\'s targeted `release --lane=N` no longer drops the other holder\'s lease', () => {
    const { a, b } = acquireTwoSiblings();
    // agent A releases B's lane by mistake — same CLAUDE_CODE_SESSION_ID, and it named the lane.
    const wrong = runPool(['release', `--lane=${b.lane}`, ...poolArgs(), `--session=${a.holder}`, '--json'], 'sess-uuid-shared');
    expect(wrong.code).toBe(0); // release logs + skips, it never hard-fails
    expect(JSON.parse(wrong.out).released).toBe(0);
    expect(wrong.out + wrong.err).toMatch(/CONTESTED/);
    // the deny must NAME the remedy, or it becomes the next false-deny footgun (#2986/#2994)
    expect(wrong.out + wrong.err).toMatch(new RegExp(`release --lane=${b.lane} --session=${b.holder}`));
  });

  it('the TRUE holder still releases its own contested lane, with no --force, by asserting its slug', () => {
    const { b } = acquireTwoSiblings();
    const right = runPool(['release', `--lane=${b.lane}`, ...poolArgs(), `--session=${b.holder}`, '--json'], 'sess-uuid-shared');
    expect(right.code).toBe(0);
    expect(JSON.parse(right.out).released).toBe(1);
    expect(right.out + right.err).not.toMatch(/not yours/);
  });

  it.each(['delivered', 'synced', 'abandoned', 'dirty', 'unlanded', 'foreign', 'sweep'])('contested release with stale lane origin/main: %s', (state) => {
    const { b } = acquireTwoSiblings();
    const dir = join(poolRoot, 'releaseowner', `lane-${b.lane}`);
    const marker = join(dir, '.git', '.lane-lease');
    const oldTip = git(['rev-parse', 'HEAD'], dir);
    git(['update-ref', 'refs/remotes/origin/main', oldTip], dir);
    // Git records seconds, whereas acquiredAt has milliseconds; keep the ordering deterministic.
    const later = {
      ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() + 2000).toISOString(),
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    };
    if (state === 'synced' || state === 'abandoned') {
      // A LIVE lane that made no commit and only fast-forwarded to a main that moved after its acquire:
      // clean, HEAD on upstream, newer than acquiredAt — and still not delivered work. `abandoned` is the same
      // lane after it committed WIP and then reset it away: a `commit` reflog entry exists, but it never landed.
      if (state === 'abandoned') {
        writeFileSync(join(dir, 'wip.txt'), 'wip\n');
        git(['add', 'wip.txt'], dir);
        execFileSync('git', ['commit', '--quiet', '-m', 'wip'], { cwd: dir, env: later });
      }
      writeFileSync(join(referenceDir, 'file.txt'), 'someone else landed this\n');
      git(['add', 'file.txt'], referenceDir);
      execFileSync('git', ['commit', '--quiet', '-m', 'landed by another'], { cwd: referenceDir, env: later });
      const head = git(['rev-parse', 'HEAD'], referenceDir);
      git(['update-ref', 'refs/remotes/origin/main', head], referenceDir);
      // The lane reads the new object through its existing alternates, while its own main ref stays stale.
      git(['reset', '--hard', head], dir);
    } else {
      // The holder's own commit, which then landed on upstream main.
      writeFileSync(join(dir, 'file.txt'), 'landed work\n');
      git(['add', 'file.txt'], dir);
      execFileSync('git', ['commit', '--quiet', '-m', 'delivered'], { cwd: dir, env: later });
      if (state !== 'unlanded') git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], dir)], dir);
      if (state === 'dirty') writeFileSync(join(dir, 'file.txt'), 'unfinished work\n');
    }
    const release = runPool([
      'release', state === 'sweep' ? '--all' : `--lane=${b.lane}`, ...poolArgs(), '--session=finishing-agent', '--json',
    ], state === 'foreign' ? 'sess-foreign' : 'sess-uuid-shared');
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(state === 'delivered' ? 1 : 0);
    if (state === 'delivered') {
      expect(release.err).toContain(`lane-${b.lane}: contested lease released — its work is fully landed`);
      expect(() => readFileSync(marker)).toThrow();
    } else {
      expect(release.err).toContain('not yours');
      expect(JSON.parse(readFileSync(marker, 'utf8')).holder).toBe(b.holder);
      if (state === 'dirty') expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('unfinished work\n');
    }
  });

  it('the OPERATOR escape is intact — --force still breaks a contested lease (stale-lane cleanup keeps working)', () => {
    const { a, b } = acquireTwoSiblings();
    const forced = runPool(['release', `--lane=${b.lane}`, '--force', ...poolArgs(), `--session=${a.holder}`, '--json'], 'sess-uuid-shared');
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out).released).toBe(1);
  });

  it('MUST-ALLOW: an UNCONTESTED release is untouched — the #2452 ownerSession fallback still works alone', () => {
    // One holder, no sibling ⇒ not contested ⇒ the durable-id fallback answers, exactly as #2452 shipped it.
    expect(runPool(['provision', '--count=2', ...poolArgs()], 'sess-uuid-solo').code).toBe(0);
    const solo = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=solo', '--json'], 'sess-uuid-solo').out);
    const release = runPool(['release', `--lane=${solo.lane}`, ...poolArgs(), '--session=different-host-B', '--json'], 'sess-uuid-solo');
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);
  });

  it('a lease held by a genuinely DIFFERENT session is still refused, contested or not (no refusal weakened)', () => {
    expect(runPool(['provision', '--count=2', ...poolArgs()], 'sess-uuid-A').code).toBe(0);
    const theirs = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=theirs', '--json'], 'sess-uuid-A').out);
    const release = runPool(['release', `--lane=${theirs.lane}`, ...poolArgs(), '--session=mine-host-B'], 'sess-uuid-B');
    expect(release.out + release.err).toMatch(/not yours/);
  });

  // r2 (independent review of PR #1234, F2). The SIBLINGS were filtered to live, but the SUBJECT lease was
  // never staleness-checked — so an EXPIRED lease with a live same-`ownerSession` sibling read as CONTESTED and
  // could not be released without `--force`. That is a regression against main AND a direct contradiction of
  // this item's own ruling, stated in three places: "a stale lease reads as no lease, EVERYWHERE". A dead
  // holder has no one to be confused with, so there is nothing to prove.
  it('a STALE lease releases with NO --force even when a live sibling shares its ownerSession (review F2)', () => {
    const { a, b } = acquireTwoSiblings();
    // Age B's lease out by 10 days, leaving everything else (including its minted holder slug) intact —
    // EXCEPT `session`: rewrite it to a foreign slug, matching what a real dead holder's marker looks like
    // (round 1's own repro used `session:"dead"`). #2997-review round 2, N1 — without this, `session` was
    // left as whatever `defaultSession()` resolved to when B was acquired, which is `${hostname()}:${ppid}`
    // of THIS test file's own vitest worker process — the SAME value `release` below resolves to (no
    // `--session` given, same worker, same ppid). `leaseOwnedByCaller`'s step-1 exact-`session` match then
    // returns true immediately, and the staleness/contested logic this test exists to pin is never reached:
    // reverting the F2 fix left the whole suite green, because this test never exercised it.
    const marker = join(poolRoot, 'releaseowner', `lane-${b.lane}`, '.git', '.lane-lease');
    const aged = {
      ...JSON.parse(readFileSync(marker, 'utf8')),
      session: 'Mac:dead-agent',
      acquiredAt: new Date(Date.now() - 10 * 864e5).toISOString(),
    };
    writeFileSync(marker, JSON.stringify(aged, null, 2) + '\n');
    expect(a.holder).toBeTruthy(); // lane A is still LIVE and shares B's ownerSession — the contested shape

    const release = runPool(['release', `--lane=${b.lane}`, ...poolArgs(), '--json'], 'sess-uuid-shared');
    expect(release.code).toBe(0);
    expect(JSON.parse(release.out).released).toBe(1);
    expect(release.out + release.err).not.toMatch(/CONTESTED/);
    expect(release.out + release.err).not.toMatch(/not yours/);
  });

  // r2 (review F4/M7) — the idempotent re-acquire path is documented to KEEP the existing holder slug ("never
  // invalidates the slug the current holder is already asserting"), but nothing pinned it: re-minting on every
  // re-acquire passed the whole suite. A re-mint turns the holder's next legitimate destructive op into a
  // mismatch deny, i.e. a self-inflicted false refusal.
  it('an IDEMPOTENT re-acquire by the current holder PRESERVES its minted slug (review F4)', () => {
    expect(runPool(['provision', '--count=2', ...poolArgs()], 'sess-uuid-idem').code).toBe(0);
    const first = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--session=holder-A', '--purpose=idem', '--json'], 'sess-uuid-idem').out);
    const again = JSON.parse(runPool(['acquire', `--lane=${first.lane}`, ...poolArgs(), '--no-reset', '--session=holder-A', '--purpose=idem', '--json'], 'sess-uuid-idem').out);
    expect(again.lane).toBe(first.lane);
    expect(again.holder).toBe(first.holder);
    // …and the slug still on disk is the one the holder is asserting, not a freshly minted one.
    const marker = join(poolRoot, 'releaseowner', `lane-${first.lane}`, '.git', '.lane-lease');
    expect(JSON.parse(readFileSync(marker, 'utf8')).holder).toBe(first.holder);
  });
});

// ── #2997 r2 — `adopt`, the dispatcher → worker OCCUPANCY hand-off (independent review of PR #1234, F1) ────
//
// `acquire` stamps `ownerSession` from the env of the process that RUNS it. When an operator leases a lane and
// hands it to a spawned agent, that field records the OPERATOR — the working agent runs under its own session
// id and matches nothing on the marker. The first cut of Gap 1 denied Edit/Write on that mismatch, which would
// have locked every dispatched agent out of the lane leased FOR it. Occupancy is now declared, not inferred.
describe('lane-pool #2997 r2 — adopt declares the OCCUPANT (the signal guard-lane actually reads)', () => {
  const leaseOf = (lane) => JSON.parse(readFileSync(join(poolRoot, 'releaseowner', `lane-${lane}`, '.git', '.lane-lease'), 'utf8'));

  it('an ordinary acquire declares NO occupant — `ownerSession` is only "who ran acquire"', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()], 'sess-DISPATCHER').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=fix-1234', '--json'], 'sess-DISPATCHER').out);
    expect(leaseOf(a.lane).ownerSession).toBe('sess-DISPATCHER');
    expect('workerSession' in leaseOf(a.lane)).toBe(false); // marker byte-shape unchanged from pre-r2
    expect(a.workerSession).toBeNull();
  });

  it('the WORKER adopts the lane it was handed, and the marker records ITS session, not the dispatcher\'s', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()], 'sess-DISPATCHER').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=fix-1234', '--json'], 'sess-DISPATCHER').out);
    const adopt = runPool(['adopt', `--lane=${a.lane}`, ...poolArgs(), '--json'], 'sess-WORKER');
    expect(adopt.code).toBe(0);
    expect(JSON.parse(adopt.out).workerSession).toBe('sess-WORKER');
    const lease = leaseOf(a.lane);
    expect(lease.workerSession).toBe('sess-WORKER');
    expect(lease.ownerSession).toBe('sess-DISPATCHER'); // untouched — release ownership (#2452) is unaffected
    expect(lease.holder).toBe(a.holder);                // and the minted slug survives the hand-off
  });

  it('`acquire --adopt` stamps the occupant in one step, for the agent that leases its OWN lane', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()], 'sess-SELF').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--adopt', '--purpose=self', '--json'], 'sess-SELF').out);
    expect(a.workerSession).toBe('sess-SELF');
    expect(leaseOf(a.lane).workerSession).toBe('sess-SELF');
  });

  it('adopting a lane a DIFFERENT live session already occupies is REFUSED without --force, and names who holds it', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()], 'sess-DISPATCHER').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--purpose=fix-1234', '--json'], 'sess-DISPATCHER').out);
    expect(runPool(['adopt', `--lane=${a.lane}`, ...poolArgs()], 'sess-WORKER').code).toBe(0);

    const steal = runPool(['adopt', `--lane=${a.lane}`, ...poolArgs()], 'sess-INTRUDER');
    expect(steal.code).not.toBe(0);
    expect(steal.err).toMatch(/already declared as occupied by session sess-WORKER/);
    expect(leaseOf(a.lane).workerSession).toBe('sess-WORKER'); // unchanged

    // …and the deliberate takeover works, naming who is displaced.
    const forced = runPool(['adopt', `--lane=${a.lane}`, '--force', ...poolArgs()], 'sess-INTRUDER');
    expect(forced.code).toBe(0);
    expect(forced.err).toMatch(/took over from sess-WORKER/);
    expect(leaseOf(a.lane).workerSession).toBe('sess-INTRUDER');
  });

  it('re-adopting my own lane is idempotent, and adopting an unleased lane is refused', () => {
    expect(runPool(['provision', '--count=2', ...poolArgs()], 'sess-SELF').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--adopt', '--purpose=self', '--json'], 'sess-SELF').out);
    expect(runPool(['adopt', `--lane=${a.lane}`, ...poolArgs()], 'sess-SELF').code).toBe(0);
    expect(leaseOf(a.lane).workerSession).toBe('sess-SELF');
    const free = a.lane === 1 ? 2 : 1;
    const none = runPool(['adopt', `--lane=${free}`, ...poolArgs()], 'sess-SELF');
    expect(none.code).not.toBe(0);
    expect(none.err).toMatch(/holds no lease to adopt/);
  });

  it('an idempotent re-acquire KEEPS the declared occupant — a re-acquire never silently un-protects a lane', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()], 'sess-SELF').code).toBe(0);
    const a = JSON.parse(runPool(['acquire', ...poolArgs(), '--no-reset', '--session=holder-A', '--adopt', '--purpose=self', '--json'], 'sess-SELF').out);
    expect(runPool(['acquire', `--lane=${a.lane}`, ...poolArgs(), '--no-reset', '--session=holder-A', '--purpose=self', '--json'], 'sess-SELF').code).toBe(0);
    expect(leaseOf(a.lane).workerSession).toBe('sess-SELF');
  });
});
