/**
 * @file scripts/__tests__/lane-whois.test.mjs
 * @description Proof of #3383's `lane-whois.mjs` — the read-only per-lane report over a real (throwaway)
 * pool: current lease + holder-alive, last holder (ledger or inference), uncommitted/ahead summary + proof of
 * preservation, card/PR lookup, and the four-way verdict. Real child process, private `LANE_POOL_ROOT`, no
 * network (`gh`/`claude` are faked on PATH) — same tier-1 geometry as the other `lane-pool-*` suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

import ts from 'typescript';
import { fetchAllPrs, restPullToListShape } from '../lane-whois.mjs';

const POOL_SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const WHOIS_SCRIPT = resolve(process.cwd(), 'scripts/lane-whois.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let base, originDir, referenceDir, poolRoot, binDir, env;

function runPool(args) {
  const r = spawnSync('node', [POOL_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function runWhois(args) {
  const r = spawnSync('node', [WHOIS_SCRIPT, ...args], { encoding: 'utf8', cwd: referenceDir, env });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=whoispool', '--branch=main', '--no-install'];
const lanePath = (n) => join(poolRoot, 'whoispool', `lane-${n}`);

function pushCard(num, status) {
  const dir = join(referenceDir, 'backlog');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${num}-item.md`), `---\nstatus: ${status}\n---\n\n# item ${num}\n`);
  git(['add', 'backlog'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `card ${num} ${status}`], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
}

describe('disposable lane integration', () => {
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-whois-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');
  binDir = join(base, 'bin');
  mkdirSync(binDir);
  // Fake `gh` (no PRs anywhere) and `claude agents --json` (no live sessions) so the report never touches the
  // network or a real Claude Code session listing. `lsof` is faked too (#xl5xhmj) — `reclaim`'s direct-reset
  // path now ALSO runs the liveness gate (`lib/lane-salvage.mjs#laneLivenessGate`), which shells `lsof` for
  // live process cwds; faking it keeps this file hermetic rather than depending on the real host's `lsof`.
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "[]"\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(binDir, 'lsof'), 0o755);
  env = {
    ...process.env, LANE_POOL_ROOT: poolRoot, PATH: `${binDir}:${process.env.PATH}`, HOME: base,
    // #xl5xhmj — the SAME gate's quiet-period half defaults to 30 minutes; zeroed here so this file's one
    // `reclaim` call (a clean, just-provisioned lane) reads as quiet immediately, unrelated to what it tests.
    WE_LANE_SALVAGE_QUIET_MIN: '0',
  };

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);

  expect(runPool(['provision', '--count=3', ...poolArgs()]).code).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('lane-whois — BEFORE (the gap)', () => {
  it('a plain `status`/`list` never answers "who used this lane, and is it done?" — whois does', () => {
    // (documented, not asserted against a command that doesn't exist — `lane-pool.mjs` has no `whois` verb at
    // all; that's the gap. `lane-whois.mjs` is the new, separate module that closes it — see the AAFTER block.)
    const r = runPool(['status', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/verdict|reclaimable/i);
  });
});

describe('lane-whois — AFTER', () => {
  it('a clean, unleased, untouched lane is finished-reclaimable (nothing to lose)', () => {
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('finished-reclaimable');
    expect(report.lanes[0].holderAlive).toBe(false);
  });

  // #4344 — `headSha`/`branch`/`branchTipSha` are what lets a caller (`lane-pool-health-watch.mjs`) tell
  // "already at the pool branch tip" apart from "clean, but still behind it" with no git of its own.
  it('exposes headSha/branch/branchTipSha at the top level, and they agree for a lane genuinely at the tip', () => {
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const row = JSON.parse(r.out).lanes[0];
    const originTip = git(['rev-parse', 'origin/main'], referenceDir);
    expect(row.branch).toBe('main');
    expect(row.headSha).toBe(originTip);
    expect(row.branchTipSha).toBe(originTip);
    expect(row.headSha).toBe(row.branchTipSha); // this lane was never advanced past the tip — genuinely clean
  });

  // A lane can be clean-relative-to-HEAD (no dirty files, no local commits ahead of `origin/main`) yet still
  // sit BEHIND the tip — nothing has fast-forwarded it since `origin/main` moved on. `ahead.count` alone (0)
  // cannot tell these apart; `headSha` vs `branchTipSha` can.
  it('reports headSha != branchTipSha for a lane that is clean but genuinely behind the tip', () => {
    // Push a NEW commit to origin/main from a second clone, WITHOUT touching lane-1 at all — it stays exactly
    // where `provision` first put it: clean (no dirty files, no ahead commits), but now behind the moved tip.
    const secondClone = join(base, 'second-clone');
    git(['clone', '--quiet', originDir, secondClone]);
    writeFileSync(join(secondClone, 'later.txt'), 'landed after lane-1 was provisioned\n');
    git(['add', 'later.txt'], secondClone);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'later work'], secondClone);
    git(['push', '--quiet', 'origin', 'main'], secondClone);
    // lane-1's own clone must see the new tip on its remote-tracking ref for this comparison to mean anything
    // (mirrors what a real pool lane already does via its own periodic fetch) — this is a read, not a reset.
    git(['fetch', '--quiet', 'origin'], lanePath(1));

    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const row = JSON.parse(r.out).lanes[0];
    expect(row.uncommitted.trackedModified + row.uncommitted.untracked).toBe(0);
    expect(row.ahead.count).toBe(0);
    expect(row.verdict).toBe('finished-reclaimable'); // classifyLaneVerdict's own rule is unchanged by #4344
    expect(row.headSha).not.toBe(row.branchTipSha); // but genuinely behind — a caller must still reclaim it
  });

  // #4344 — the two ends of this contract (the report's real, untouched `--json` shape, and
  // `reclaimFinishedLanes`'s consumption of it) are otherwise only ever proven against hand-built fixtures on
  // EITHER side, never wired together. This closes that gap with the REAL `--json` output, no fixture in
  // between, over the same lane the two tests above already prove `headSha`/`branch`/`branchTipSha` on.
  it('wiring: a REAL whois --json report feeds reclaimFinishedLanes correctly — at-tip skipped, behind-tip reclaimed, stray-branch reclaimed', async () => {
    const { reclaimFinishedLanes } = await import('../conveyor/lane-pool-health-watch.mjs');

    // lane-1: untouched since `provision` — genuinely at the pool branch tip.
    const atTip = JSON.parse(runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    // The branch-name guard's own input actually exists on a REAL report, on both ends — not just asserted by
    // the outcome below, which would pass identically if `branch` were absent everywhere.
    expect(atTip.branch).toMatch(/^origin\//);
    expect(atTip.lanes[0].branch).toBe('main');
    const calls1 = [];
    const outcomes1 = reclaimFinishedLanes({ whois: atTip, reclaimLane: (o) => { calls1.push(o); return { reclaimed: true }; }, dryRun: false });
    expect(calls1).toEqual([]);
    expect(outcomes1).toEqual([{ lane: 1, reclaimed: false, alreadyClean: true, reason: 'already clean at the pool branch tip — nothing to reclaim' }]);

    // lane-2: origin/main moves on from a second clone, lane-2 fetches but is never reset — clean, but behind.
    const secondClone = join(base, 'second-clone-wiring');
    git(['clone', '--quiet', originDir, secondClone]);
    writeFileSync(join(secondClone, 'later2.txt'), 'landed after lane-2 was provisioned\n');
    git(['add', 'later2.txt'], secondClone);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'later work 2'], secondClone);
    git(['push', '--quiet', 'origin', 'main'], secondClone);
    git(['fetch', '--quiet', 'origin'], lanePath(2));

    const behindTip = JSON.parse(runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    const calls2 = [];
    const outcomes2 = reclaimFinishedLanes({ whois: behindTip, reclaimLane: (o) => { calls2.push(o); return { reclaimed: true }; }, dryRun: false });
    expect(calls2).toEqual([{ lane: 2, dryRun: false }]); // never silently skipped — reclaim still has real work to do
    expect(outcomes2).toEqual([{ lane: 2, reclaimed: true }]);

    // lane-3: exact tip sha, but checked out on a stray LOCAL branch (never touches origin at all) — the
    // branch-name guard must still send this one to a real reclaim, not skip it as already-clean.
    git(['checkout', '--quiet', '-b', 'some-stray-branch'], lanePath(3));
    const strayBranch = JSON.parse(runWhois(['--lane=3', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    expect(strayBranch.lanes[0].branch).toBe('some-stray-branch');
    expect(strayBranch.lanes[0].headSha).toBe(strayBranch.lanes[0].branchTipSha); // exact tip sha — only the branch is wrong
    const calls3 = [];
    const outcomes3 = reclaimFinishedLanes({ whois: strayBranch, reclaimLane: (o) => { calls3.push(o); return { reclaimed: true }; }, dryRun: false });
    expect(calls3).toEqual([{ lane: 3, dryRun: false }]); // branch-name guard: never skipped on a stray branch
    expect(outcomes3).toEqual([{ lane: 3, reclaimed: true }]);
  });

  it('a live-leased lane reports in-use, regardless of content', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-a', ...poolArgs()]).code).toBe(0);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('in-use');
    expect(report.lanes[0].holderAlive).toBe(true);
    expect(report.lanes[0].lease.session).toBe('sess-a');
  });

  // #xl5xhmj fork 3 — the old `liveOwner = !!lease && isSessionAlive(...)` read was ALWAYS false for an
  // UNLEASED lane, no matter how live its worker actually was, which is exactly the shape a dropped/expired
  // lease leaves (see #xbk2is9). `liveOwner` must answer "is a live agent sitting in this lane" independent of
  // whether a lease still exists — the SAME `liveAgentInLane` read `lane-pool.mjs`'s own reclaim gate uses.
  it('an UNLEASED lane with a live agent still sitting in it (cwd match) reports liveOwner:true, holderAlive:true (#xl5xhmj)', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-b', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=sess-b', ...poolArgs()]).code).toBe(0);
    // Its lease is gone (released), but its own process is STILL live, sitting in the lane's directory —
    // `claude agents --json` still lists it (the exact #xl5xhmj shape: a lease dropped out from under a live
    // worker that has already pushed).
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[{"sessionId":"sess-b","state":"working","cwd":"${lanePath(1)}"}]'\n`);
    chmodSync(join(binDir, 'claude'), 0o755);

    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].lease).toBeNull();
    expect(report.lanes[0].liveOwner).toBe(true);
    expect(report.lanes[0].holderAlive).toBe(true);
  });

  it('a released lane has no owner even when its historical session is working elsewhere', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-d', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=sess-d', ...poolArgs()]).code).toBe(0);
    // The agent's cwd is a DIFFERENT lane entirely — only its session id matches this lane's last ledger entry.
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[{"sessionId":"sess-d","state":"working","cwd":"${lanePath(2)}"}]'\n`);
    chmodSync(join(binDir, 'claude'), 0o755);

    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].lastHolder.session).toBe('sess-d');
    expect(report.lanes[0].liveOwner).toBe(false);
    expect(report.lanes[0].holderAlive).toBe(false);
    expect(report.lanes[0].verdict).toBe('finished-reclaimable');
  });

  it('ledger entry without a session and session-less foreign agent reports liveOwner:false', () => {
    writeFileSync(join(lanePath(1), '.git', 'lane-history.jsonl'), JSON.stringify({ event: 'release', at: '2026-09-28T00:00:00Z', holder: 'legacy-holder' }) + '\n');
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[{"state":"working","cwd":"${lanePath(2)}"}]'\n`);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    const row = JSON.parse(r.out).lanes[0];
    expect(row.lastHolder.holder).toBe('legacy-holder');
    expect(row.lastHolder.session).toBeUndefined();
    expect(row.liveOwner).toBe(false);
  });

  // #4544 — `liveOwner` stays fail-safe (any listed entry), but `liveWorker` is true only for a RUNNING session.
  const whoisWithListing = (sess, entry) => {
    expect(runPool(['acquire', '--lane=1', `--session=${sess}`, ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', `--session=${sess}`, ...poolArgs()]).code).toBe(0);
    writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho '[${JSON.stringify({ sessionId: sess, cwd: lanePath(1), ...entry })}]'\n`);
    chmodSync(join(binDir, 'claude'), 0o755);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    expect(r.code).toBe(0);
    return JSON.parse(r.out).lanes[0];
  };

  it('liveWorker is false for a listed but idle session, while liveOwner stays true (#4544)', () => {
    const row = whoisWithListing('sess-i', { status: 'idle' });
    expect(row.liveOwner).toBe(true);
    expect(row.liveWorker).toBe(false);
  });

  it('liveWorker is true for a working background session (#4544)', () => {
    expect(whoisWithListing('sess-w', { state: 'working' }).liveWorker).toBe(true);
  });

  it('liveWorker is true for a busy interactive session (#4544)', () => {
    expect(whoisWithListing('sess-bz', { status: 'busy' }).liveWorker).toBe(true);
  });

  it('liveWorker is false for a working entry whose last activity is older than the window (#4544)', () => {
    const row = whoisWithListing('sess-h', { state: 'working', lastActivityAt: Date.now() - 60 * 60_000 });
    expect(row.liveOwner).toBe(true);
    expect(row.liveWorker).toBe(false);
  });

  it('liveWorker is false for an entry with no state or an unknown state, while liveOwner is true (#4544)', () => {
    for (const [sess, entry] of [['sess-n', {}], ['sess-u', { state: 'mystery' }]]) {
      const row = whoisWithListing(sess, entry);
      expect(row.liveOwner).toBe(true);
      expect(row.liveWorker).toBe(false);
    }
  });

  it('an UNLEASED lane with NO live agent reports liveOwner:false (unchanged default)', () => {
    expect(runPool(['acquire', '--lane=1', '--session=sess-c', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=sess-c', ...poolArgs()]).code).toBe(0);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].liveOwner).toBe(false);
    expect(report.lanes[0].holderAlive).toBe(false);
  });

  it('reads the last holder off the lane-history ledger once one exists', () => {
    // release derives `item` from the session's own dispatcher-grammar name (itemNumFromSession) — see
    // lane-pool-history-ledger.test.mjs for the same convention.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-3901', '--item=3901', ...poolArgs()]).code).toBe(0);
    expect(runPool(['release', '--lane=1', '--session=conveyor-3901', ...poolArgs()]).code).toBe(0);
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].lastHolder.event).toBe('release');
    expect(report.lanes[0].lastHolder.session).toBe('conveyor-3901');
    expect(report.lanes[0].lastHolder.item).toBe('3901');
  });

  it('a card resolved on main + an ahead commit PUSHED to its own remote lane/* branch is finished-reclaimable, WITH proof', () => {
    pushCard('4200', 'resolved');
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-4200', '--item=4200', ...poolArgs()]).code).toBe(0);
    // Commit in the lane, then push it to its OWN `lane/*` ref (exactly what `pr-land.mjs` does) — the PR
    // built off that ref then merges (mirrored here by resolving the card), so the commit is provably
    // preserved on a remote branch even though it never reaches `origin/main` under this same sha.
    const dir = lanePath(1);
    writeFileSync(join(dir, 'work.txt'), 'landed via PR\n');
    git(['add', 'work.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', '4200: land work'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/4200-test'], dir);
    expect(runPool(['release', '--lane=1', '--session=conveyor-4200', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    const row = report.lanes[0];
    expect(row.ahead.count).toBe(1);
    expect(row.ahead.commits[0].preserved).toBe(true); // patch-equivalent (empty diff) already "in" main
    expect(row.cards).toEqual([{ id: '4200', status: 'resolved' }]);
    expect(row.preserved).toBe(true);
    expect(row.verdict).toBe('finished-reclaimable');
  });

  it('unpreserved uncommitted content on a resolved card is finished-needs-review, never auto-reclaimed', () => {
    pushCard('4201', 'resolved');
    expect(runPool(['acquire', '--lane=2', '--session=conveyor-4201', '--item=4201', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(2);
    writeFileSync(join(dir, 'new-work.txt'), 'never pushed anywhere\n');
    expect(runPool(['release', '--lane=2', '--session=conveyor-4201', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    const row = report.lanes[0];
    expect(row.uncommitted.untracked).toBe(1);
    expect(row.preserved).toBe(false);
    expect(row.unpreservedFiles).toEqual(['new-work.txt']);
    expect(row.verdict).toBe('finished-needs-review');
  });

  it('untouched content with an OPEN card is unknown-work', () => {
    pushCard('4202', 'open');
    expect(runPool(['acquire', '--lane=3', '--session=conveyor-4202', '--item=4202', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(3), 'wip.txt'), 'still going\n');
    expect(runPool(['release', '--lane=3', '--session=conveyor-4202', ...poolArgs()]).code).toBe(0);

    const r = runWhois(['--lane=3', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes[0].verdict).toBe('unknown-work');
  });

  it('lanesNeedingDecision surfaces only finished-needs-review / unknown-work lanes — the operator-queue feed', async () => {
    const { lanesNeedingDecision } = await import('../lane-whois.mjs');
    const decisions = lanesNeedingDecision({
      lanes: [
        { exists: true, lane: 1, verdict: 'in-use' },
        { exists: true, lane: 2, verdict: 'finished-reclaimable' },
        { exists: true, lane: 3, verdict: 'finished-needs-review', reason: 'x', path: '/a', preserved: false },
        { exists: true, lane: 4, verdict: 'unknown-work', reason: 'y', path: '/b', preserved: true },
        // #4139 — a KEPT lane, however it verdicts, is excluded until its content changes again.
        { exists: true, lane: 5, verdict: 'finished-needs-review', reason: 'z', path: '/c', kept: true },
      ],
    });
    expect(decisions.map((d) => d.lane)).toEqual([3, 4]);
    expect(decisions.find((d) => d.lane === 3).preserved).toBe(false);
    expect(decisions.find((d) => d.lane === 4).preserved).toBe(true);
  });

  // #4139 — the KEEP marker, read live off a real lane through `lane-pool.mjs keep` + `lane-whois.mjs`.
  it('a lane KEPT by the operator reports kept:true with the recorded reason, and is dropped from lanesNeedingDecision', async () => {
    const { lanesNeedingDecision } = await import('../lane-whois.mjs');
    pushCard('4203', 'resolved');
    expect(runPool(['acquire', '--lane=2', '--session=conveyor-4203', '--item=4203', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(2), 'litter.log'), 'scratch, safe to lose\n');
    expect(runPool(['release', '--lane=2', '--session=conveyor-4203', ...poolArgs()]).code).toBe(0);

    // Before `keep`: a normal finished-needs-review row, surfaced.
    const before = JSON.parse(runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    expect(before.lanes[0].verdict).toBe('finished-needs-review');
    expect(before.lanes[0].kept).toBe(false);
    expect(lanesNeedingDecision(before).map((d) => d.lane)).toEqual([2]);

    expect(runPool(['keep', '--lane=2', '--reason=litter.log is scratch, safe to leave', ...poolArgs()]).code).toBe(0);

    const after = JSON.parse(runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    expect(after.lanes[0].kept).toBe(true);
    expect(after.lanes[0].keptInfo.reason).toBe('litter.log is scratch, safe to leave');
    expect(lanesNeedingDecision(after)).toEqual([]); // dropped from the operator-queue feed
  });

  it('a KEPT decision goes stale the moment the lane\'s content changes — it resurfaces, never silenced forever', () => {
    pushCard('4204', 'resolved');
    expect(runPool(['acquire', '--lane=2', '--session=conveyor-4204', '--item=4204', ...poolArgs()]).code).toBe(0);
    writeFileSync(join(lanePath(2), 'litter.log'), 'scratch\n');
    expect(runPool(['release', '--lane=2', '--session=conveyor-4204', ...poolArgs()]).code).toBe(0);
    expect(runPool(['keep', '--lane=2', ...poolArgs()]).code).toBe(0);

    const kept = JSON.parse(runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    expect(kept.lanes[0].kept).toBe(true);

    // New content appears — the SAME lane, but the fingerprint the marker recorded no longer matches.
    writeFileSync(join(lanePath(2), 'new-file.txt'), 'fresh, never reviewed\n');
    const stale = JSON.parse(runWhois(['--lane=2', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]).out);
    expect(stale.lanes[0].kept).toBe(false);
  });

  // #4344 review (security juror) — the whole safety argument for skipping a reclaim on an at-local-tip lane
  // rests on `lane-pool.mjs reclaim` never fetching (see `isLaneAlreadyClean`'s own docblock). That was a prose
  // claim about ANOTHER file with no test pinning it — this is that test: real origin advances via a SECOND
  // clone (never fetched into lane-1), then a REAL `reclaim` runs on lane-1, and the proof is that its HEAD
  // stays exactly where it was — reclaim reset it to its own stale local knowledge of `origin/main`, not the
  // real remote tip, because it never fetched to learn the remote had moved.
  it('reclaim never fetches — it resets an at-tip lane to its OWN locally-known origin/main, not a fresher remote tip', () => {
    const beforeSha = git(['rev-parse', 'HEAD'], lanePath(1));

    const secondClone = join(base, 'second-clone-reclaim-no-fetch');
    git(['clone', '--quiet', originDir, secondClone]);
    writeFileSync(join(secondClone, 'moved-on.txt'), 'origin/main advances; lane-1 never fetches this\n');
    git(['add', 'moved-on.txt'], secondClone);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'origin moved on'], secondClone);
    git(['push', '--quiet', 'origin', 'main'], secondClone);
    const remoteTipSha = git(['rev-parse', 'main'], secondClone);
    expect(remoteTipSha).not.toBe(beforeSha); // the real remote tip genuinely moved

    const r = runPool(['reclaim', '--lane=1', '--json', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).reclaimed).toBe(true); // clean + unleased — "nothing to lose", reclaimed as expected

    const afterSha = git(['rev-parse', 'HEAD'], lanePath(1));
    expect(afterSha).toBe(beforeSha); // unchanged — reclaim reset to its own stale knowledge, never fetched
    expect(afterSha).not.toBe(remoteTipSha); // proof it did NOT pick up the real remote tip
  });

  it('#3383-perf: a lane with MANY genuinely-unpushed ahead commits is scanned in bounded time (speed regression guard)', () => {
    // Before the #3383 speed follow-up, `aheadCommits` ran one `git log -1` PER commit for subjects, and
    // `aheadCommitsPreserved` ran one unbounded `git branch -r --contains <sha>` PER commit that `git cherry`
    // couldn't already prove equivalent — a lane with N genuinely-orphaned ahead commits cost O(N) extra
    // spawns on top of everything else. None of these 30 commits are pushed anywhere or patch-equivalent to
    // origin/main, so every one of them used to hit that unbounded fallback.
    expect(runPool(['acquire', '--lane=1', '--session=conveyor-perf', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(join(dir, `perf-${i}.txt`), `content ${i}\n`);
      git(['add', `perf-${i}.txt`], dir);
      git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', `perf work ${i}`], dir);
    }
    expect(runPool(['release', '--lane=1', '--session=conveyor-perf', ...poolArgs()]).code).toBe(0);

    const startedAt = Date.now();
    const r = runWhois(['--lane=1', '--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const elapsedMs = Date.now() - startedAt;
    expect(r.code).toBe(0);
    const row = JSON.parse(r.out).lanes[0];
    expect(row.ahead.count).toBe(30);
    expect(row.preserved).toBe(false); // none of these were ever pushed — correctly NOT preserved
    expect(row.verdict).not.toBe('finished-reclaimable'); // never wrongly reclaimable
    // Generous bound for a CI/dev host (real target is the whole ~68-lane pool in well under 60s) — this
    // guards against the specific O(N) blowup class regressing, not a tight perf SLA on this one lane.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('perf-lane-whois: commitPreservedOnRemote probes named refs only, and treats a missing object as unknown (false, logged once)', async () => {
    const { commitPreservedOnRemote } = await import(WHOIS_SCRIPT);
    const root = mkdtempSync(join(tmpdir(), 'whois-cpr-'));
    try {
      const origin = join(root, 'origin.git');
      const dir = join(root, 'clone');
      git(['init', '--quiet', '--bare', '-b', 'main', origin], root);
      git(['clone', '--quiet', origin, dir], root);
      const c = (m) => git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', m], dir);
      git(['checkout', '--quiet', '-b', 'main'], dir);
      c('base');
      git(['push', '--quiet', 'origin', 'main'], dir);
      git(['checkout', '--quiet', '-b', 'lane/x'], dir);
      c('pushed');
      const pushed = git(['rev-parse', 'HEAD'], dir).trim();
      git(['push', '--quiet', 'origin', 'lane/x'], dir);
      c('unpushed');
      const unpushed = git(['rev-parse', 'HEAD'], dir).trim();
      const base = git(['rev-parse', 'main'], dir).trim();
      expect(commitPreservedOnRemote(dir, base, 'origin/main')).toBe(true);
      expect(commitPreservedOnRemote(dir, pushed, 'origin/main')).toBe(true); // own pushed branch
      expect(commitPreservedOnRemote(dir, unpushed, 'origin/main')).toBe(false);
      const writes = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = (m) => { writes.push(String(m)); return true; };
      try {
        const missing = 'bf857f498f548620e0dbb912f1a7d4ad86322aea';
        expect(commitPreservedOnRemote(dir, missing, 'origin/main')).toBe(false);
        expect(commitPreservedOnRemote(dir, missing, 'origin/main')).toBe(false);
      } finally { process.stderr.write = orig; }
      expect(writes.filter((w) => w.includes('lane-whois: preservation')).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // PR #2641 review — `lane-pool.mjs reclaim`'s re-check used to run the cross-ref fallback unbounded; both it
  // and `whoisForLane` now share `lanePreservedFileChecker`, whose lane-wide budget this pins.
  it('lanePreservedFileChecker spends ONE lane-wide fallback budget across every dirty file', async () => {
    const { lanePreservedFileChecker, otherRemoteRefs } = await import(WHOIS_SCRIPT);
    expect(runPool(['acquire', '--lane=1', '--session=s', ...poolArgs()]).code).toBe(0);
    const dir = lanePath(1);
    // Two files whose content lives ONLY on another remote branch — provable solely via the fallback scan.
    // No trailing newline: `filePreservedInMain` compares against `tryGit` output, which strips one (a
    // pre-existing, fail-closed quirk on main — out of this test's scope).
    writeFileSync(join(dir, 'a.txt'), 'A');
    writeFileSync(join(dir, 'b.txt'), 'B');
    git(['add', 'a.txt', 'b.txt'], dir);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'side'], dir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/9002-side'], dir);
    git(['reset', '--quiet', '--mixed', 'origin/main'], dir); // a.txt / b.txt now untracked, same content
    const dirty = ['a.txt', 'b.txt'];
    const refCount = otherRemoteRefs(dir, 'origin/main').length;
    expect(refCount).toBeGreaterThan(0);

    const unbounded = lanePreservedFileChecker(dir, 'origin/main', dirty);
    expect(dirty.map(unbounded)).toEqual([true, true]);
    // Budget exactly one file's worth of refs: the first file spends it all, the second gets no fallback.
    const bounded = lanePreservedFileChecker(dir, 'origin/main', dirty, { maxFallbackShows: refCount });
    expect(dirty.map(bounded)).toEqual([true, false]);
  });

  it('scans every requested lane in ONE transcript grep pass (no lane left unreported)', () => {
    const r = runWhois(['--json', `--repo=${referenceDir}`, '--name=whoispool', `--pool-root=${poolRoot}`]);
    const report = JSON.parse(r.out);
    expect(report.lanes.map((l) => l.lane)).toEqual([1, 2, 3]);
  });
});

});

// Bounded syntactic contract: this mapper starts with an unconditional nullish rejection.
// Requiring the first statement avoids pretending to implement general control-flow analysis.
function hasDominatingNullishRejection(source) {
  const ast = ts.createSourceFile('mapper.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'restPullToListShape');
  const parameter = fn?.parameters[0]?.name;
  if (!parameter || !ts.isIdentifier(parameter)) return false;
  const first = fn.body?.statements[0];
  if (!first || !ts.isIfStatement(first) || first.elseStatement) return false;
  const condition = first.expression;
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
    || !ts.isIdentifier(condition.left) || condition.left.text !== parameter.text
    || condition.right.kind !== ts.SyntaxKind.NullKeyword) return false;
  const rejection = ts.isBlock(first.thenStatement) ? first.thenStatement.statements : [first.thenStatement];
  return rejection.length === 1 && ts.isThrowStatement(rejection[0]);
}

describe('#4429 whois prevention boundaries', () => {
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'whois-boundary-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('structural guard rejects mixed guards and requires dominating nullish rejection', () => {
    expect(hasDominatingNullishRejection('function restPullToListShape(p) { const s = p && p.state; return p.number; }')).toBe(false);
    expect(hasDominatingNullishRejection('function restPullToListShape(p) { p.number; if (p == null) throw new TypeError(); }')).toBe(false);
    expect(hasDominatingNullishRejection('function restPullToListShape(p) { if (p == null) throw new TypeError(); return p.number; }')).toBe(true);
    expect(hasDominatingNullishRejection(readFileSync(WHOIS_SCRIPT, 'utf8'))).toBe(true);
  });

  it('rejects nullish mapper inputs and preserves nullable field defaults', () => {
    expect(() => restPullToListShape(null)).toThrow(TypeError);
    expect(() => restPullToListShape(undefined)).toThrow(TypeError);
    expect(restPullToListShape({ number: 1, state: 'open', head: null, title: null, body: null }))
      .toEqual({ number: 1, state: 'OPEN', headRefName: '', title: '', body: '' });
  });

  it.each(['a/b/c', 'a/b/', './b', 'a/..', 'a/b?x', 'a/b#x', 'a/b%2fx', 'a/ b'])
  ('rejects full invalid slug even with fresh outer cache: %s', ghRepo => {
    const poolDir = join(base, 'pr-cache');
    mkdirSync(poolDir);
    const cache = join(poolDir, '.whois-pr-cache.json');
    const text = JSON.stringify({ ghRepo, fetchedAtMs: 100, prs: [{ number: 1 }] });
    let calls = 0;
    const exec = () => { calls++; return '[]'; };
    vi.stubEnv('WE_GH_ETAG_CACHE', '0');
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', join(base, 'throttle'));
    expect(fetchAllPrs({ ghRepo, poolDir, exec, nowMs: 100 })).toEqual([]);
    expect(existsSync(cache)).toBe(false);
    writeFileSync(cache, text);
    expect(fetchAllPrs({ ghRepo, poolDir, exec, nowMs: 100 })).toEqual([]);
    expect(readFileSync(cache, 'utf8')).toBe(text);
    expect(calls).toBe(0);
  });

  it.each([undefined, '', 'a.b-c_d/e.f-g_h'])('fetches valid or absent repository: %j', ghRepo => {
    vi.stubEnv('WE_GH_ETAG_CACHE', '0');
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', join(base, 'throttle'));
    const seen = [];
    const exec = (f, args) => { seen.push(args.at(-1)); return '[{"number":1,"state":"open"}]'; };
    expect(fetchAllPrs({ ghRepo, exec })).toHaveLength(1);
    expect(seen).toEqual([`repos/${ghRepo || '{owner}/{repo}'}/pulls?state=all&per_page=100&page=1`]);
  });

  it('malformed pull list retains all-or-empty evidence', () => {
    vi.stubEnv('WE_GH_ETAG_CACHE', '0');
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', join(base, 'throttle'));
    let calls = 0;
    expect(fetchAllPrs({ ghRepo: 'o/r', exec: () => { calls++; return '[{"number":1},null]'; } })).toEqual([]);
    expect(calls).toBe(1);
  });
});
