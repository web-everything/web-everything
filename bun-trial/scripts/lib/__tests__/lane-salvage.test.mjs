/**
 * @file lane-salvage.test.mjs — snapshot-then-reclaim (2026-09-27 lane-pool starvation). Pure-core tests plus
 * real-git tests: a dirty lane with an unpushed commit, an untracked file, a CONFLICTED index and a litter
 * worktree is salvaged into a verified bundle that restores every byte, and the working tree is untouched.
 */
import { describe, it, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, lstatSync, readlinkSync,
  realpathSync, utimesSync, chmodSync, lutimesSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  salvageStamp, salvageRefNames, isWorktreeLitterPath, parseLsofCwds, pidsWithCwdIn, salvageEligibility,
  liveAgentInLane, deriveSalvageTargets, salvageLane, removeLitterWorktrees, listLitterWorktrees, laneLivenessGate,
  listUnregisteredWorktreeLitter, newestContentMtimeMs, resolveSalvageQuietMs, nearestAncestorMtimeMs,
} from '../../../../scripts/lib/lane-salvage.mjs';

describe('lane-salvage pure core', () => {
  it('stamps sortable UTC and names refs like the manual salvage', () => {
    expect(salvageStamp(new Date('2026-09-27T01:36:05Z'))).toBe('20260927-013605');
    expect(salvageRefNames({ lane: 7, stamp: 's' })).toEqual({ head: 'refs/salvage/lane-7-s-head', wip: 'refs/salvage/lane-7-s-wip' });
    expect(salvageRefNames({ lane: 7, stamp: 's', worktree: 'fix 1' }).wip).toBe('refs/salvage/lane-7-s-wt-fix_1-wip');
  });

  it('treats only .claude/worktrees/ as worktree litter', () => {
    expect(isWorktreeLitterPath('.claude/worktrees/fix-1/')).toBe(true);
    expect(isWorktreeLitterPath('.claude/settings.json')).toBe(false);
  });

  it('parses lsof cwd output and matches pids inside a lane (never itself)', () => {
    const cwds = parseLsofCwds('p10\nfcwd\nn/pool/lane-1\np11\nfcwd\nn/pool/lane-10\np12\nfcwd\nn/pool/lane-1/.claude/worktrees/x\n');
    expect(pidsWithCwdIn(cwds, '/pool/lane-1', 999)).toEqual([10, 12]);
    expect(pidsWithCwdIn(cwds, '/pool/lane-1', 10)).toEqual([12]);
  });

  it('counts a stateless or working agent anywhere inside the lane as live; a done one is not', () => {
    const agents = [{ state: null, cwd: '/pool/lane-3/.claude/worktrees/fix-9', sessionId: 'a' }, { state: 'done', cwd: '/pool/lane-4', sessionId: 'b' }];
    expect(liveAgentInLane(agents, '/pool/lane-3')).toBe(true);
    expect(liveAgentInLane(agents, '/pool/lane-4')).toBe(false);
    expect(liveAgentInLane([{ state: 'working', cwd: '/elsewhere', sessionId: 's1' }], '/pool/lane-5', ['s1'])).toBe(true);
  });

  it('undefined/null session ids never match an agent with no sessionId', () => {
    expect(liveAgentInLane([{ state: 'working', cwd: '/elsewhere' }], '/pool/lane-1', [undefined, null])).toBe(false);
  });

  it('matches exact session ids and lane boundaries, never PID slugs or sibling prefixes', () => {
    const agent = { state: 'working', sessionId: 'Mac:31893', pid: 31893, cwd: '/pool/lane-14-other' };
    expect(liveAgentInLane([agent], '/pool/lane-14', ['Mac:31893'])).toBe(false);
    expect(liveAgentInLane([{ ...agent, sessionId: 'session-123-more' }], '/pool/lane-14', ['session-123'])).toBe(false);
    expect(liveAgentInLane([{ ...agent, cwd: '/pool/lane-14/work' }], '/pool/lane-14')).toBe(true);
    expect(liveAgentInLane([{ state: 'working', cwd: '' }], process.cwd())).toBe(false);
  });

  it('nearest ancestor lookup stops at the lane even when every stat throws', () => {
    const seen = [];
    expect(nearestAncestorMtimeMs('/pool/lane-1/gone/a.txt', '/pool/lane-1', (p) => {
      seen.push(p);
      throw new Error('unstatable');
    })).toBeNull();
    expect(seen).toEqual(['/pool/lane-1/gone', '/pool/lane-1']);
  });

  it('eligibility refuses lease, live owner, live pid, and a recently touched lane', () => {
    const base = { leased: false, liveOwner: false, livePids: [], newestMtimeMs: 0, nowMs: 60 * 60_000, quietMs: 30 * 60_000 };
    expect(salvageEligibility(base).eligible).toBe(true);
    expect(salvageEligibility({ ...base, leased: true }).eligible).toBe(false);
    expect(salvageEligibility({ ...base, liveOwner: true }).eligible).toBe(false);
    expect(salvageEligibility({ ...base, livePids: [42] }).reason).toMatch(/pid 42/);
    expect(salvageEligibility({ ...base, newestMtimeMs: 50 * 60_000 }).reason).toMatch(/quiet period/);
  });

  // #xl5xhmj — this is a PURE unit test of `salvageEligibility`'s own clamp math, with a synthetic
  // `quietMs: 0` chosen ONLY to isolate that arithmetic — it is NOT a description of `cmdReclaim`'s own
  // production gate, which always runs at the REAL 30-minute default (`resolveSalvageQuietMs()`;
  // `cmdReclaim` never passes a `quietMs` override at all — see `we:scripts/lane-pool.mjs`). That real-default
  // path gets its own dedicated end-to-end coverage in `we:scripts/__tests__/lane-pool-reclaim.test.mjs`'s
  // "quiet period at the REAL 30-minute default" describe block, via `runPoolWithEnv` with the env var UNSET.
  // The clamp itself defends a file's on-disk mtime landing a few ms AFTER `nowMs` was sampled (mtime/clock
  // granularity, or git's own background housekeeping touching `.git/logs/HEAD` a moment after the visible
  // commit/push returned). An unclamped negative "elapsed" wrongly read as "not yet quiet" even at
  // `quietMs: 0`, where ANY elapsed time (including ~0) must trivially satisfy the threshold.
  it('a newestMtimeMs slightly AHEAD of nowMs (clock/mtime skew) never reads as "not quiet" at quietMs:0', () => {
    const g = salvageEligibility({
      leased: false, liveOwner: false, livePids: [], newestMtimeMs: 1_000_014, nowMs: 1_000_000, quietMs: 0,
    });
    expect(g).toEqual({ eligible: true, reason: 'unleased, no live owner or process, quiet' });
  });

  it('the same skew still correctly refuses when quietMs is genuinely not yet satisfied', () => {
    const g = salvageEligibility({
      leased: false, liveOwner: false, livePids: [], newestMtimeMs: 1_000_014, nowMs: 1_000_000, quietMs: 60_000,
    });
    expect(g.eligible).toBe(false);
    expect(g.reason).toMatch(/0 min ago/); // clamped to 0, never a negative minute count
  });

  it('derives PR numbers and card ids from lease purpose/holder and branch names', () => {
    expect(deriveSalvageTargets({ holder: 'conveyor-ci-heal-lane-2-201b', purpose: 'fix-2748', branches: ['lane/4229-slug', 'worktree-fix-2769'] }))
      .toEqual({ cards: ['4229'], prs: [2748, 2769] });
    expect(deriveSalvageTargets({ session: 'build-x9fbg1x' }).cards).toEqual(['x9fbg1x']);
  });
});

// #xl5xhmj — `laneLivenessGate` is the ONE liveness read `lane-pool.mjs#cmdReclaim`'s direct-reset path and
// `lane-pool-health-watch.mjs`'s litter-reap pass now both share, extracted from what used to be
// `cmdReclaimSalvage`'s own inline `gate()` closure (only that ONE path ever ran it before this fix).
describe('laneLivenessGate (#xl5xhmj)', () => {
  it('a live owner (by cwd) refuses, even with no matching sessionId supplied', () => {
    const readAgents = () => [{ state: 'working', cwd: '/pool/lane-9', sessionId: 'unrelated' }];
    const readCwds = () => [];
    const g = laneLivenessGate({ dir: '/pool/lane-9', readAgents, readCwds, quietMs: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toMatch(/live/i);
  });

  it('a released lastHolder sessionId with an agent elsewhere does not own the lane', () => {
    const readAgents = () => [{ state: 'working', cwd: '/elsewhere', sessionId: 's1' }];
    const readCwds = () => [];
    const g = laneLivenessGate({ dir: '/pool/lane-9', lastHolder: { event: 'release', workerSession: 's1' }, readAgents, readCwds, quietMs: 0 });
    expect(g.eligible).toBe(true);
  });

  it('only the current lease matches a session elsewhere; the reclaim hold can exclude itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-owner-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ session: 'current', ownerSession: 's1' }));
      const opts = { dir, readAgents: () => [{ sessionId: 's1', state: 'working', cwd: '/elsewhere' }], readCwds: () => [], quietMs: 0 };
      expect(laneLivenessGate(opts).eligible).toBe(false);
      expect(laneLivenessGate({ ...opts, ignoreLeaseSession: 'different' }).eligible).toBe(false);
      expect(laneLivenessGate({ ...opts, ignoreLeaseSession: 'current' }).eligible).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a live process cwd (no matching agent) also refuses', () => {
    const readAgents = () => [];
    const readCwds = () => [{ pid: 123, cwd: '/pool/lane-9' }];
    const g = laneLivenessGate({ dir: '/pool/lane-9', readAgents, readCwds, quietMs: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toMatch(/pid 123/);
  });

  it('no live owner, no live pid, quiet period satisfied — eligible', () => {
    const readAgents = () => [];
    const readCwds = () => [];
    const g = laneLivenessGate({ dir: '/pool/lane-9', readAgents, readCwds, quietMs: 0 });
    expect(g).toEqual({ eligible: true, reason: 'unleased, no live owner or process, quiet' });
  });

  it('fails CLOSED when `claude agents` cannot be read — never treats an unreadable lane as safe', () => {
    const g = laneLivenessGate({ dir: '/pool/lane-9', readAgents: () => null, readCwds: () => [], quietMs: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toMatch(/claude agents/);
  });

  it('fails CLOSED when live process cwds cannot be read (lsof unavailable)', () => {
    const g = laneLivenessGate({ dir: '/pool/lane-9', readAgents: () => [], readCwds: () => null, quietMs: 0 });
    expect(g.eligible).toBe(false);
    expect(g.reason).toMatch(/lsof/);
  });
});

// Red-team finding — `newestContentMtimeMs` deliberately never stats `.git/index` at all (see that function's
// own docblock for why an ordering fix inside this ONE function could not close the race: an EARLIER, unrelated
// `git status` elsewhere in the same call chain — `laneReclaimPreservationProof`'s own `gitStatusSummary` in
// `cmdReclaim` — races the index just as much as this function's own call would). These tests prove BOTH halves
// still hold without it: a fresh DELETION reads as recent via its surviving ancestor mtime,
// while aged deletions and genuinely quiet lanes read as quiet.
describe('newestContentMtimeMs (real git, #xl5xhmj)', () => {
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'newest-mtime-'));
    git('init', '-q');
    git('config', 'user.email', 't@t.com');
    git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    writeFileSync(join(dir, 'b.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a STAGED DELETION (the tracked path no longer exists on disk) still reads as recent, via the surviving ancestor mtime', () => {
    // Back-date logs/HEAD first so the ONLY fresh signal left is the deletion itself — `bump` cannot stat a
    // path `git rm` already removed from the working tree, so this pins the ancestor mtime, not logs/HEAD.
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, '.git', 'logs', 'HEAD'), old, old);
    git('rm', '-q', 'a.txt'); // staged deletion — a.txt no longer exists on disk to stat
    const before = Date.now();
    const newest = newestContentMtimeMs(dir);
    expect(newest).not.toBeNull();
    expect(newest).toBeGreaterThanOrEqual(before - 5_000); // recent (within a few seconds), not the back-dated hour
  });

  it.each(['staged file', 'removed parent directory'])('aged deletion reads quiet: %s', (shape) => {
    mkdirSync(join(dir, 'nested', 'gone'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'gone', 'tracked.txt'), 'tracked\n');
    writeFileSync(join(dir, 'nested', 'gone', 'retained.txt'), 'retained\n');
    git('add', '.');
    git('commit', '-qm', 'nested file');
    if (shape === 'staged file') git('rm', '-q', 'nested/gone/tracked.txt');
    else rmSync(join(dir, 'nested'), { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const ancestor = shape === 'staged file' ? join(dir, 'nested', 'gone') : dir;
    utimesSync(ancestor, old, old);
    utimesSync(join(dir, '.git', 'logs', 'HEAD'), old, old);
    // Repeated scans leave the deletion in place; observing it must never refresh its age.
    for (let i = 0; i < 3; i++) {
      expect(Date.now() - newestContentMtimeMs(dir)).toBeGreaterThanOrEqual(60 * 60_000);
      expect(laneLivenessGate({ dir, quietMs: 30 * 60_000, readAgents: () => [], readCwds: () => [] }).eligible).toBe(true);
      expect(git('status', '--porcelain')).toContain('D ');
    }
  });

  it('a genuinely quiet lane (nothing staged, HEAD reflog old) still reads as old — the original racy-index bug stays fixed', () => {
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(join(dir, '.git', 'logs', 'HEAD'), old, old);
    // `git status` (what `dirtyPaths` shells) may itself rewrite `.git/index` here — the exact race this
    // function's docblock describes. Never stat-ing the index at all is what this test pins.
    const newest = newestContentMtimeMs(dir);
    expect(newest).not.toBeNull();
    expect(Date.now() - newest).toBeGreaterThan(55 * 60_000); // still reads as ~an hour old, not "just now"
  });
});

describe('salvageLane (real git)', () => {
  let root; let origin; let lane; let salvageRoot;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-salvage-test-'));
    origin = join(root, 'origin.git');
    lane = join(root, 'lane-5');
    salvageRoot = join(root, 'salvage');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, lane], { stdio: 'ignore' });
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(lane, 'config', k, v);
    writeFileSync(join(lane, 'a.txt'), 'base\n');
    writeFileSync(join(lane, 'c.txt'), 'base-c\n');
    git(lane, 'add', '.'); git(lane, 'commit', '-qm', 'base'); git(lane, 'push', '-q', 'origin', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('bundles an unpushed commit + tracked edit + untracked file + conflicted file + litter worktree, without touching the tree', () => {
    writeFileSync(join(lane, 'a.txt'), 'ahead\n'); git(lane, 'commit', '-qam', 'unpushed work');
    // A conflicted index (the lane-22 case: "needs merge" made `git stash` fail).
    git(lane, 'checkout', '-qb', 'side', 'origin/main'); writeFileSync(join(lane, 'c.txt'), 'side\n'); git(lane, 'commit', '-qam', 'side');
    git(lane, 'checkout', '-q', 'main'); writeFileSync(join(lane, 'c.txt'), 'main-c\n'); git(lane, 'commit', '-qam', 'main-c');
    try { git(lane, 'merge', 'side'); } catch { /* conflict expected */ }
    expect(git(lane, 'status', '--porcelain')).toMatch(/^UU c\.txt/m);
    writeFileSync(join(lane, 'new.txt'), 'untracked\n');
    mkdirSync(join(lane, '.claude', 'worktrees'), { recursive: true });
    git(lane, 'worktree', 'add', '-q', '-b', 'worktree-fix-2777', join(lane, '.claude', 'worktrees', 'fix-2777'), 'origin/main');
    writeFileSync(join(lane, '.claude', 'worktrees', 'fix-2777', 'wt.txt'), 'wt work\n');
    const before = git(lane, 'status', '--porcelain');

    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z'), meta: { lastHolder: { purpose: 'fix-2748' } } });

    expect(git(lane, 'status', '--porcelain')).toBe(before); // working tree + real index untouched
    expect(rec.bundle).toBe(join(salvageRoot, 'p', '20260927-020000', 'lane-5.bundle'));
    expect(rec.prs).toEqual(expect.arrayContaining([2748, 2777]));
    expect(rec.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'c.txt', 'new.txt', 'wt.txt']));
    const index = readFileSync(join(salvageRoot, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ lane: 5, pool: 'p', landed: false });

    // Restore from the bundle ALONE into a fresh clone of origin: every byte comes back.
    const restore = join(root, 'restore');
    execFileSync('git', ['clone', '-q', origin, restore], { stdio: 'ignore' });
    git(restore, 'fetch', '-q', rec.bundle, 'refs/salvage/*:refs/salvage/*');
    const wip = 'refs/salvage/lane-5-20260927-020000-wip';
    expect(git(restore, 'show', `${wip}:a.txt`)).toBe('ahead');
    expect(git(restore, 'show', `${wip}:new.txt`)).toBe('untracked');
    expect(git(restore, 'show', `${wip}:c.txt`)).toMatch(/<<<<<<<[\s\S]*main-c[\s\S]*side/);
    expect(git(restore, 'show', 'refs/salvage/lane-5-20260927-020000-wt-fix-2777-wip:wt.txt')).toBe('wt work');
    expect(git(restore, 'ls-tree', '-r', '--name-only', wip)).not.toMatch(/\.claude\/worktrees/);
    expect(readFileSync(join(salvageRoot, 'p', '20260927-020000', 'lane-5.unpushed.txt'), 'utf8')).toMatch(/unpushed work/);

    // Worktree litter is removed properly afterwards.
    const wts = listLitterWorktrees(lane);
    expect(wts.map((w) => w.name)).toEqual(['fix-2777']);
    expect(removeLitterWorktrees(lane, wts)).toEqual(['fix-2777']);
    expect(existsSync(join(lane, '.claude', 'worktrees', 'fix-2777'))).toBe(false);
  });

  it('includeLocalBranches (a clone about to be deleted) also bundles a non-HEAD branch no remote has', () => {
    git(lane, 'checkout', '-qb', 'side-work'); writeFileSync(join(lane, 's.txt'), 'side\n'); git(lane, 'add', 's.txt'); git(lane, 'commit', '-qm', 'side only');
    git(lane, 'checkout', '-q', 'main');
    const rec = salvageLane({ dir: lane, lane: 'stray', pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z'), includeLocalBranches: true });
    expect(rec.refs).toEqual(['refs/salvage/lane-stray-20260927-020000-ref-heads_side-work']);
    expect(git(lane, 'bundle', 'list-heads', rec.bundle)).toMatch(/ref-heads_side-work/);
  });

  it('a lane with nothing unique writes no bundle (nothing to lose)', () => {
    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') });
    expect(rec.bundle).toBeNull();
    expect(rec.refs).toEqual([]);
  });

  // #4273 — reproduces the CONFIRMED finding: an ordinary (non-git) file/dir sitting directly under
  // `.claude/worktrees/` WITHOUT ever being `git worktree add`-ed was invisible to salvage and permanently lost
  // once `we:scripts/lane-pool.mjs`'s reclaim path ran its `git clean -fd` right after. This test fails before
  // the fix (no `rec.litter`, no copy — the file is simply gone after `clean -fd`) and passes after.
  it('an UNREGISTERED file/dir under .claude/worktrees/ is copied by salvageLane and survives the caller\'s later `git clean -fd`', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray', 'nested'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'stray', 'important.txt'), 'unregistered litter\n');
    writeFileSync(join(lane, '.claude', 'worktrees', 'stray', 'nested', 'deep.txt'), 'deep litter\n');

    expect(listUnregisteredWorktreeLitter(lane)).toEqual([{ path: join(realpathSync(lane), '.claude', 'worktrees', 'stray'), rel: 'stray' }]);

    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') });
    expect(rec.litter).toEqual([{ rel: 'stray', dest: join(salvageRoot, 'p', '20260927-020000', 'lane-5.wt-litter', 'stray') }]);
    expect(readFileSync(join(rec.litter[0].dest, 'important.txt'), 'utf8')).toBe('unregistered litter\n');
    expect(readFileSync(join(rec.litter[0].dest, 'nested', 'deep.txt'), 'utf8')).toBe('deep litter\n');
    const indexed = readFileSync(join(salvageRoot, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(indexed[indexed.length - 1].litter).toEqual(rec.litter);

    // Exactly the sequence `lane-pool.mjs`'s `cmdReclaimSalvage` runs right after `salvageLane` returns.
    execFileSync('git', ['reset', '--hard', 'origin/main'], { cwd: lane });
    execFileSync('git', ['clean', '-fd', '--quiet'], { cwd: lane });
    expect(existsSync(join(lane, '.claude', 'worktrees', 'stray'))).toBe(false); // really gone from the lane

    // ...but fully recoverable from the salvage copy.
    expect(readFileSync(join(rec.litter[0].dest, 'important.txt'), 'utf8')).toBe('unregistered litter\n');
  });

  it('a mixed ancestor — a registered worktree PLUS an unregistered sibling in the same subdirectory — captures both, and the sibling alone is copied (not the whole ancestor)', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'group'), { recursive: true });
    git(lane, 'worktree', 'add', '-q', '-b', 'worktree-fix-9001', join(lane, '.claude', 'worktrees', 'group', 'registered'), 'origin/main');
    mkdirSync(join(lane, '.claude', 'worktrees', 'group', 'loose'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'group', 'loose', 'x.txt'), 'loose sibling\n');

    const unreg = listUnregisteredWorktreeLitter(lane);
    expect(unreg).toEqual([{ path: join(realpathSync(lane), '.claude', 'worktrees', 'group', 'loose'), rel: join('group', 'loose') }]);

    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') });
    expect(rec.litter).toEqual([{ rel: join('group', 'loose'), dest: join(salvageRoot, 'p', '20260927-020000', 'lane-5.wt-litter', 'group', 'loose') }]);
    expect(readFileSync(join(rec.litter[0].dest, 'x.txt'), 'utf8')).toBe('loose sibling\n');
    // The registered worktree itself is still handled the existing way — NOT copied raw (no directory for it
    // under the litter root)...
    expect(existsSync(join(salvageRoot, 'p', '20260927-020000', 'lane-5.wt-litter', 'group', 'registered'))).toBe(false);
    // ...but genuinely snapshotted (a real git ref, not merely "absent from the litter copy" — the two are not
    // the same claim): `rec.worktrees` lists it, and `rec.snapshots` carries a real head sha for it, restorable
    // exactly like the plain (non-mixed) litter-worktree case the first test in this file already proves.
    expect(rec.worktrees.map((w) => w.name)).toEqual(['group/registered']);
    const wtSnapshot = rec.snapshots.find((s) => s.worktree === 'group/registered');
    expect(wtSnapshot?.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  // #4273 review — the docblock claims the mixed-ancestor descent goes "recursively, to whatever depth the
  // mixing actually occurs at — not just one level"; the test above only mixes at ONE level (`group/`). This
  // one mixes at TWO nested levels at once (`a/` and `a/b/`), so a regression that hardcoded a single-level
  // descent (rather than a genuine recursion) would miss the deeper sibling and fail here.
  it('a mixed ancestor recurses to MULTIPLE nested levels, not just one — an unregistered sibling at each depth is still found', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'a', 'b'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'a', 'loose-shallow.txt'), 'shallow sibling\n'); // mixed at depth 1
    git(lane, 'worktree', 'add', '-q', '-b', 'worktree-fix-9002', join(lane, '.claude', 'worktrees', 'a', 'b', 'registered'), 'origin/main');
    mkdirSync(join(lane, '.claude', 'worktrees', 'a', 'b', 'loose-deep'), { recursive: true }); // mixed at depth 2
    writeFileSync(join(lane, '.claude', 'worktrees', 'a', 'b', 'loose-deep', 'y.txt'), 'deep sibling\n');

    const unreg = listUnregisteredWorktreeLitter(lane);
    expect(unreg.map((u) => u.rel).sort()).toEqual([join('a', 'b', 'loose-deep'), join('a', 'loose-shallow.txt')].sort());

    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') });
    const litterRoot = join(salvageRoot, 'p', '20260927-020000', 'lane-5.wt-litter');
    expect(readFileSync(join(litterRoot, 'a', 'loose-shallow.txt'), 'utf8')).toBe('shallow sibling\n');
    expect(readFileSync(join(litterRoot, 'a', 'b', 'loose-deep', 'y.txt'), 'utf8')).toBe('deep sibling\n');
    expect(existsSync(join(litterRoot, 'a', 'b', 'registered'))).toBe(false); // the registered worktree is never raw-copied
    expect(rec.worktrees.map((w) => w.name)).toEqual(['a/b/registered']);
  });

  // A RELATIVE link target (never absolute) — so a regression that dropped `verbatimSymlinks`/`dereference:false`
  // (letting cpSync re-resolve the target relative to the NEW destination, or follow it into a plain copy of
  // the file's bytes) would actually change what `readlinkSync` reports, unlike an absolute target that
  // happens to still resolve correctly by coincidence either way.
  it('an unregistered SYMLINK (relative target) under .claude/worktrees/ is copied as a symlink, verbatim, never dereferenced', () => {
    mkdirSync(join(lane, '.claude', 'worktrees'), { recursive: true });
    writeFileSync(join(lane, 'target.txt'), 'link target\n');
    const linkPath = join(lane, '.claude', 'worktrees', 'sneaky-link');
    const relativeTarget = relative(join(lane, '.claude', 'worktrees'), join(lane, 'target.txt')); // '../../target.txt'
    symlinkSync(relativeTarget, linkPath);

    const unreg = listUnregisteredWorktreeLitter(lane);
    expect(unreg).toEqual([{ path: join(realpathSync(lane), '.claude', 'worktrees', 'sneaky-link'), rel: 'sneaky-link' }]);

    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') });
    expect(lstatSync(rec.litter[0].dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(rec.litter[0].dest)).toBe(relativeTarget); // the EXACT bytes of the original link, untouched
  });

  it('listUnregisteredWorktreeLitter returns [] when .claude/worktrees/ does not exist at all', () => {
    expect(listUnregisteredWorktreeLitter(lane)).toEqual([]);
  });

  // This test and its `locked`-directory sibling below deliberately chmod a real directory to 0o000 for a
  // few synchronous statements. Two CI runs (test-shard (1), runs 36509203076 and 36516127216) crashed the
  // whole vitest worker (SIGABRT, exit 134) on this fixture with an uncaught
  // `std::filesystem::filesystem_error` — root cause CONFIRMED (reproduced live, non-root, on
  // node:22.23.2-bookworm/Linux, CI's exact Node version): `salvageLane`'s own `fs.cpSync({recursive:true})`
  // call (NOT cross-file contention — an earlier per-file `poolMatchGlobs` isolation attempt did not stop the
  // second crash) throws that uncaught native exception when its native directory walk meets a
  // permission-denied directory. Fixed at the source in `we:scripts/lib/lane-salvage.mjs`
  // (`copyLitterTreeSync` — see its docblock) by replacing that native recursive copy with a hand-rolled walk
  // over plain libuv-backed calls, every one of which throws an ordinary catchable JS error instead. These
  // two tests exercising the unreadable-directory path are what proves that fix; the tight revoke-then-
  // restore window here is just cheap insurance, not the mechanism the crash actually needed.
  it('#4273 review — listUnregisteredWorktreeLitter propagates when .claude/worktrees ITSELF is unstattable for a reason OTHER than absence (never silently reads that as "[]" the way a bare existsSync would)', () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores POSIX perms — chmod can't deny it
    mkdirSync(join(lane, '.claude', 'worktrees'), { recursive: true });
    chmodSync(join(lane, '.claude'), 0o000); // deny traversal into `.claude` — lstat('.claude/worktrees') EACCESs
    try {
      expect(() => listUnregisteredWorktreeLitter(lane)).toThrow();
    } finally { chmodSync(join(lane, '.claude'), 0o755); } // restore so afterEach's rmSync can clean up
  });

  // #4273 review — a naive "backdate the lane's OWN git files, then assert `newest` reads as recent" does NOT
  // actually isolate the litter contribution: `git status` (which `dirtyPaths()` runs on every call) refreshes
  // `.git/index`'s own mtime to essentially "now" on EVERY invocation, regardless of any real change — so
  // `newestContentMtimeMs` reads as "just touched" from that side effect alone, litter or not, and a
  // backdated-then-reset baseline can never prove which one actually produced the fresh reading. Setting the
  // litter file's mtime into the FUTURE sidesteps that entirely: git's own index-refresh can only ever produce
  // a timestamp of "now" (never later), so a returned `newest` at or past that instant can ONLY have come from
  // the litter fold-in.
  it('newestContentMtimeMs folds an unregistered litter mtime in — even one FURTHER IN THE FUTURE than the lane\'s own (git-refreshed) activity could ever read', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    const litterFile = join(lane, '.claude', 'worktrees', 'stray', 'f.txt');
    writeFileSync(litterFile, 'fresh\n');
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h ahead — unreachable by any "now"-only refresh
    utimesSync(litterFile, future, future);

    const newest = newestContentMtimeMs(lane);
    // Within a few ms of the future stamp — filesystem mtime storage can round sub-ms, so an exact `>=` is
    // too strict; what matters is that it is nowhere NEAR "now", which only the litter fold-in explains.
    expect(newest).toBeGreaterThan(future.getTime() - 5);
  });

  // #4273 review — the litter mtime walk must use `lstat`, never `stat`, on a symlink: it must count the
  // LINK's own mtime, not silently dereference to whatever it points at. Sets the link's OWN mtime (via
  // `lutimesSync`, which — unlike `utimesSync` — never follows the link) to the FUTURE and its TARGET's mtime
  // to something ordinary, so a regression that dereferenced (`statSync` instead of `lstatSync`) would read the
  // target's mtime instead and this test would redden.
  it('newestContentMtimeMs reads a litter SYMLINK\'s own mtime (lstat), never its target\'s (a stat-vs-lstat regression would redden here)', () => {
    writeFileSync(join(lane, 'target-ordinary.txt'), 'ordinary target\n');
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    const linkPath = join(lane, '.claude', 'worktrees', 'stray', 'link-to-ordinary');
    symlinkSync(join(lane, 'target-ordinary.txt'), linkPath);
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000); // further ahead than the OTHER future-mtime test, to tell them apart if both ran
    lutimesSync(linkPath, future, future); // the LINK's own mtime — never followed to the target

    const newest = newestContentMtimeMs(lane);
    expect(newest).toBeGreaterThan(future.getTime() - 5);
  });

  it('#4273 review — an UNREADABLE litter entry propagates (never silently reads as absent/quiet), and salvageLane throws rather than resetting a half-salvaged lane', () => {
    if (process.getuid && process.getuid() === 0) return; // root ignores POSIX perms — chmod can't deny it
    mkdirSync(join(lane, '.claude', 'worktrees', 'locked'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'locked', 'secret.txt'), 'x');
    chmodSync(join(lane, '.claude', 'worktrees', 'locked'), 0o000); // deny read+execute on the directory itself
    try {
      // Listing alone does NOT need to read INSIDE an entirely-unregistered directory — `lstatSync` on its
      // NAME (from the parent's own readdir) is enough to return it as one opaque leaf to copy whole, so this
      // does not throw. The permission failure surfaces one level down, where something actually has to
      // descend into `locked/` itself (the mtime walk, and salvageLane's copy).
      expect(listUnregisteredWorktreeLitter(lane)).toEqual([{ path: join(realpathSync(lane), '.claude', 'worktrees', 'locked'), rel: 'locked' }]);
      expect(() => newestContentMtimeMs(lane)).toThrow(); // its recursive mtime walk DOES descend — propagates, never silently "quiet"
      expect(() => salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') })).toThrow(); // cpSync must read INSIDE `locked` to copy it
      // No index row for a salvage that never actually completed.
      expect(existsSync(join(salvageRoot, 'index.jsonl'))).toBe(false);
    } finally { chmodSync(join(lane, '.claude', 'worktrees', 'locked'), 0o755); } // restore so afterEach's rmSync can clean up
  });

  it('#4273 review — salvageLane throws (never silently clobbers) when a litter destination already exists', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'stray', 'f.txt'), 'fresh\n');
    // Pre-create the exact destination salvageLane would copy into, with DIFFERENT content, simulating a
    // colliding/leftover artifact from an earlier run at the same stamp.
    const destRoot = join(salvageRoot, 'p', '20260927-020000', 'lane-5.wt-litter', 'stray');
    mkdirSync(destRoot, { recursive: true });
    writeFileSync(join(destRoot, 'f.txt'), 'DO NOT OVERWRITE\n');
    expect(() => salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date('2026-09-27T02:00:00Z') })).toThrow();
    expect(readFileSync(join(destRoot, 'f.txt'), 'utf8')).toBe('DO NOT OVERWRITE\n'); // never silently clobbered
  });

  // MIRRORS the composition, rather than exercising `cmdReclaimSalvage` itself: that function lives in
  // `we:scripts/lane-pool.mjs` and is not exported for import, so this test cannot literally call through it —
  // it re-creates its exact call shape (at the time of writing, `salvageEligibility({ …, newestMtimeMs:
  // newestContentMtimeMs(dir), … })` right before `salvageLane`) from THIS library's own exports. If that
  // composition in `lane-pool.mjs` ever drifts, this test would not catch it — only re-reading `cmdReclaimSalvage`
  // there (currently: `we:scripts/lane-pool.mjs`'s `gate()` closure inside `cmdReclaimSalvage`) would. What
  // this DOES prove, beyond a unit test of `salvageLane` in isolation: litter's mtime really reaches the
  // eligibility computation (not just `newestContentMtimeMs` alone), and that `salvageLane` — what a real
  // reclaim runs right after an eligible gate — still captures it. A FUTURE litter mtime is used rather than
  // "block while fresh, then age it back to quiet": `git status` (run inside `newestContentMtimeMs` on every
  // call) refreshes `.git/index`'s own mtime to "now" on EVERY invocation regardless of real changes, so no
  // baseline reading of this gate can ever be made to look genuinely quiet from a test — only a timestamp
  // beyond what that refresh could ever produce proves the litter path, not the git-refresh side effect, is
  // what the gate saw.
  it('#4273 review — mirrors the real gate composition (salvageEligibility + newestContentMtimeMs, as we:scripts/lane-pool.mjs composes them at time of writing): litter\'s mtime reaches it, and salvageLane still captures it', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    const litterFile = join(lane, '.claude', 'worktrees', 'stray', 'wip.txt');
    writeFileSync(litterFile, 'still being written\n');
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // unreachable by the index's own "now"-only refresh
    utimesSync(litterFile, future, future);

    const gate = salvageEligibility({
      leased: false, liveOwner: false, livePids: [],
      newestMtimeMs: newestContentMtimeMs(lane), nowMs: Date.now(), quietMs: resolveSalvageQuietMs(),
    });
    expect(gate.eligible).toBe(false); // the same-shaped gate cmdReclaimSalvage composes refuses — litter's mtime alone does this
    expect(gate.reason).toMatch(/quiet period/);

    // Eligibility only GATES when salvageLane runs in the real reclaim path; salvageLane itself is unconditional
    // once past that gate, and captures the litter regardless of its own mtime.
    const rec = salvageLane({ dir: lane, lane: 5, pool: 'p', branchRef: 'origin/main', salvageRoot, now: new Date() });
    expect(rec.litter).toHaveLength(1);
    expect(readFileSync(join(rec.litter[0].dest, 'wip.txt'), 'utf8')).toBe('still being written\n');
  });
});
