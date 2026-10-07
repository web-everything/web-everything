/**
 * @file salvage-index.test.mjs — the read side of lane salvage: brief hint, landed marking, 14-day expiry,
 * manual-salvage backfill; plus pool-leftover classification, pool-exhaustion summary and the health-watch
 * salvage candidate / low-pool alert cores.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  salvageHintFor, salvageEntriesFor, salvageHintLine, withSalvageHint, refreshSalvageIndex, readSalvageIndex, parseSalvageStamp,
  backfillSalvageDir, isUnderSalvageRoot,
} from '../salvage-index.mjs';
import { salvageLane, appendSalvageIndex } from '../lane-salvage.mjs';
import { classifyPoolLeftover } from '../pool-leftovers.mjs';
import { summarizePoolExhaustion, formatPoolExhaustion, makePoolExhaustionLogger } from '../../conveyor/pool-exhaustion.mjs';
import { planSalvageCandidates, lowPoolAlert, reclaimFinishedLanes } from '../../conveyor/lane-pool-health-watch.mjs';

const DAY = 24 * 60 * 60 * 1000;

describe('salvage hint', () => {
  const entries = [
    { ts: '2026-09-27T01:00:00Z', cards: ['4229'], prs: [], bundle: '/s/a.bundle', landed: false },
    { ts: '2026-09-27T02:00:00Z', cards: [], prs: [2769], bundle: '/s/b.bundle', landed: false },
    { ts: '2026-09-27T03:00:00Z', cards: [], prs: [2769], bundle: '/s/c.bundle', landed: true },
  ];
  it('matches not-landed entries by card or PR, newest first', () => {
    expect(salvageEntriesFor(entries, { prs: [2769] }).map((e) => e.bundle)).toEqual(['/s/b.bundle']);
    expect(salvageEntriesFor(entries, { cards: ['4229'], prs: [2769] }).map((e) => e.bundle)).toEqual(['/s/b.bundle', '/s/a.bundle']);
    expect(salvageEntriesFor(entries, { cards: [undefined, ''] })).toEqual([]);
  });
  it('renders the one brief line, and appends it to a prompt only when there is a match', () => {
    expect(salvageHintLine([entries[0]])).toMatch(/^Earlier unfinished work for this item was salvaged at \/s\/a\.bundle — inspect\/reuse before starting over/);
    const root = mkdtempSync(join(tmpdir(), 'salv-hint-'));
    try {
      appendSalvageIndex(root, entries[1]);
      expect(withSalvageHint('BRIEF', { prs: [2769], root })).toMatch(/^BRIEF\n\nEarlier unfinished work .*\/s\/b\.bundle/);
      expect(withSalvageHint('BRIEF', { prs: [1], root })).toBe('BRIEF');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('parses both manual and automatic stamps', () => {
    expect(new Date(parseSalvageStamp('20260926-2136')).toISOString()).toBe('2026-09-26T21:36:00.000Z');
    expect(new Date(parseSalvageStamp('20260927-015411')).toISOString()).toBe('2026-09-27T01:54:11.000Z');
    expect(parseSalvageStamp('nope')).toBeNull();
  });
});

describe('refreshSalvageIndex + backfill (real git)', () => {
  let root; let origin; let lane; let salvageRoot;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'salv-idx-'));
    origin = join(root, 'origin.git'); lane = join(root, 'lane-3'); salvageRoot = join(root, 'salvage');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, lane], { stdio: 'ignore' });
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(lane, 'config', k, v);
    writeFileSync(join(lane, 'a.txt'), 'base\n'); git(lane, 'add', '.'); git(lane, 'commit', '-qm', 'base'); git(lane, 'push', '-q', 'origin', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('marks an entry landed once main carries the salvaged content, and expires entries past 14 days (files + refs + row)', () => {
    writeFileSync(join(lane, 'a.txt'), 'work\n');
    const now = new Date('2026-09-27T02:00:00Z');
    const rec = salvageLane({ dir: lane, lane: 3, pool: 'p', branchRef: 'origin/main', salvageRoot, now });
    expect(refreshSalvageIndex({ root: salvageRoot, nowMs: now.getTime() }).landed).toHaveLength(0);
    // The same change lands on main by another path.
    const other = join(root, 'other');
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
    writeFileSync(join(other, 'a.txt'), 'work\n'); git(other, 'commit', '-qam', 'landed'); git(other, 'push', '-q', 'origin', 'main');
    git(lane, 'fetch', '-q', 'origin');
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: now.getTime() });
    expect(r.landed.map((e) => e.lane)).toEqual([3]);
    expect(readSalvageIndex(salvageRoot)[0].landed).toBe(true);
    // Dry-run expiry reports, real expiry deletes.
    const later = now.getTime() + 15 * DAY;
    expect(refreshSalvageIndex({ root: salvageRoot, nowMs: later, dryRun: true }).expired).toHaveLength(1);
    expect(existsSync(rec.bundle)).toBe(true);
    refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(existsSync(rec.bundle)).toBe(false);
    expect(readSalvageIndex(salvageRoot)).toEqual([]);
    expect(git(lane, 'for-each-ref', 'refs/salvage')).toBe('');
  });

  it('#4273 — expiry removes a DIRECTORY-shaped litter artifact (lane-N.wt-litter/) cleanly, and counts its EXACT nested size (no double-count from also listing litter[].dest)', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'stray', 'f.txt'), 'x'.repeat(100));
    const now = new Date('2026-09-27T02:00:00Z');
    const rec = salvageLane({ dir: lane, lane: 3, pool: 'p', branchRef: 'origin/main', salvageRoot, now });
    expect(rec.litter).toHaveLength(1);
    expect(existsSync(rec.litter[0].dest)).toBe(true); // a real directory, not a file
    expect(rec.bundle).toBeNull(); // nothing dirty/ahead in this test — only the .uncommitted.patch/.unpushed.txt
    // (both written empty) and the litter dir end up in outDir, so the EXACT expected freed size is the
    // litter file's own 100 bytes — an exact assertion (not >=) catches BOTH a reverted `pathSize` (would read
    // only the directory's own dirent size) and a re-introduced double-count (would read ~200).

    const later = now.getTime() + 15 * DAY;
    const dry = refreshSalvageIndex({ root: salvageRoot, nowMs: later, dryRun: true });
    expect(dry.expired).toHaveLength(1);
    expect(dry.bytesFreed).toBe(100);

    const real = refreshSalvageIndex({ root: salvageRoot, nowMs: later }); // must not throw on the directory
    expect(real.expired).toHaveLength(1);
    expect(real.bytesFreed).toBe(100);
    expect(existsSync(rec.litter[0].dest)).toBe(false);
    expect(readSalvageIndex(salvageRoot)).toEqual([]);
  });

  it('#4273 review — bytesFreed is not DOUBLE-COUNTED for `bundle` (which the lane-N. glob also matches, now that entryFiles returns two sets)', () => {
    writeFileSync(join(lane, 'a.txt'), 'work\n'); // an uncommitted change ⇒ a real, non-trivial bundle gets written
    const now = new Date('2026-09-27T02:00:00Z');
    const rec = salvageLane({ dir: lane, lane: 3, pool: 'p', branchRef: 'origin/main', salvageRoot, now });
    expect(rec.bundle).not.toBeNull();
    const bundleSize = statSync(rec.bundle).size;
    expect(bundleSize).toBeGreaterThan(0); // a real bundle, not the empty-file case the exact-100 test used
    // rec.patches always includes the (here non-empty, since the change is uncommitted) `.uncommitted.patch` —
    // that file's own bytes are correctly counted once; only `bundle`'s double-count is what this test guards.
    const patchSize = rec.patches.reduce((sum, p) => sum + statSync(p).size, 0);

    const later = now.getTime() + 15 * DAY;
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(r.expired).toHaveLength(1);
    expect(r.bytesFreed).toBe(bundleSize + patchSize); // bundle counted exactly once — a regression here would add bundleSize again
  });

  it('#4273 review — expiry NEVER deletes a path a (tampered/corrupt) index row points OUTSIDE the salvage root', () => {
    const victimDir = join(root, 'victim'); // a sibling of salvageRoot, never inside it
    mkdirSync(victimDir, { recursive: true });
    const victim = join(victimDir, 'precious.txt');
    writeFileSync(victim, 'x'.repeat(12345)); // a large, distinctive size — would dominate bytesFreed if walked
    appendSalvageIndex(salvageRoot, {
      ts: '2026-01-01T00:00:00Z', pool: 'p', lane: 99, dir: null, stamp: '20260101-000000',
      outDir: join(salvageRoot, 'p', '20260101-000000'), // a normal, empty, in-root outDir — nothing to glob
      bundle: victim, // the tampered field — an index-supplied path OUTSIDE salvageRoot entirely
      patches: [], litter: [], reason: 'tampered', lastHolder: {}, branch: null, head: null,
      cards: [], prs: [], changedFiles: [], refs: [], localRefs: [], snapshots: [], landed: false,
    });
    const later = Date.parse('2026-01-01T00:00:00Z') + 15 * DAY;
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(r.expired).toHaveLength(1); // the row is still dropped from the index (retention still applies)...
    expect(existsSync(victim)).toBe(true); // ...but the out-of-root content it pointed at survives untouched
    expect(r.bytesFreed).toBe(0); // ...and its (large) size is never even walked into bytesFreed
  });

  it('#4273 review — a SELF-REFERENTIAL symlink inside a litter copy never gets followed for size accounting (no ELOOP recursion, no inflated bytesFreed)', () => {
    mkdirSync(join(lane, '.claude', 'worktrees', 'stray'), { recursive: true });
    writeFileSync(join(lane, '.claude', 'worktrees', 'stray', 'real.txt'), 'x'.repeat(50));
    symlinkSync('.', join(lane, '.claude', 'worktrees', 'stray', 'self-loop')); // points AT ITS OWN DIRECTORY
    const now = new Date('2026-09-27T02:00:00Z');
    salvageLane({ dir: lane, lane: 3, pool: 'p', branchRef: 'origin/main', salvageRoot, now });

    const later = now.getTime() + 15 * DAY;
    const start = Date.now();
    const dry = refreshSalvageIndex({ root: salvageRoot, nowMs: later, dryRun: true });
    expect(Date.now() - start).toBeLessThan(5000); // never recurses into the loop
    // Only `real.txt` (50 bytes) plus the symlink's own tiny (never-followed) size — nowhere near what
    // recursing through the loop (or into the directory it points back at) would accumulate.
    expect(dry.bytesFreed).toBeGreaterThanOrEqual(50);
    expect(dry.bytesFreed).toBeLessThan(60);
  });

  // A mutation check (temporarily hardcoding `isUnderSalvageRoot` to always return `true`) proved that testing
  // it only BEHAVIORALLY, through `refreshSalvageIndex`, is not enough for two shapes: "bundle equals the
  // root" is independently saved by `deleteEntryArtifacts`'s own EISDIR-catch (a non-recursive `rmSync` on a
  // directory always throws, caught, regardless of containment), and "a glob-matched entry is itself a
  // symlink" is saved by `rmSync`'s OWN never-follow-a-symlink semantics (removing a symlink unlinks the link
  // itself; it never enters what it points at) — so a test built only around those two shapes can pass with
  // the guard deleted. `isUnderSalvageRoot` is exported and unit-tested DIRECTLY below instead — the honest way
  // to pin exactly what it decides, independent of every OTHER protection that happens to also save the same
  // scenario. The behavioral test right after it covers a shape neither incidental protection saves: an
  // ancestor directory reached only via a symlink.
  it('isUnderSalvageRoot: strictly inside the root only — never the root itself, never outside it, and never fooled by a symlink along the way', () => {
    mkdirSync(join(salvageRoot, 'p'), { recursive: true });
    writeFileSync(join(salvageRoot, 'p', 'x'), 'real, ordinary in-root file\n');
    expect(isUnderSalvageRoot(join(salvageRoot, 'p', 'x'), salvageRoot)).toBe(true);
    expect(isUnderSalvageRoot(salvageRoot, salvageRoot)).toBe(false); // the root itself — NOT "inside" it
    expect(isUnderSalvageRoot(join(root, 'elsewhere'), salvageRoot)).toBe(false); // a genuinely unrelated path

    // A path that is LEXICALLY under salvageRoot but whose real location — reached by following a symlinked
    // ANCESTOR directory — is actually outside it. A lexical-only `resolve()` comparison would wrongly call
    // this "inside"; `isUnderSalvageRoot`'s `realOrResolved` must not be fooled. (The referenced leaf must
    // actually EXIST for `realpathSync` to resolve the full chain — an absent leaf falls back to a plain
    // lexical resolve, which is fine in practice: nothing that doesn't exist is ever actually deleted or sized.)
    const victimDir = join(root, 'victim3');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, 'lane-1.bundle'), 'reached only via the symlinked ancestor\n');
    const linkedAncestor = join(salvageRoot, 'p', 'linked-stamp'); // looks like an ordinary in-root outDir...
    symlinkSync(victimDir, linkedAncestor); // ...but is actually a symlink to somewhere OUTSIDE the root
    expect(isUnderSalvageRoot(join(linkedAncestor, 'lane-1.bundle'), salvageRoot)).toBe(false);
  });

  it('#4273 review — deleteEntryArtifacts leaves the salvage root, and a symlinked-litter TARGET, intact against a tampered "bundle equals root" row and a tampered symlink-as-litter-item row (defense in depth: EISDIR-catch + rmSync\'s own never-follow-a-symlink semantics — independent of isUnderSalvageRoot, which the mutation check just above proved neither of these two scenarios actually exercises)', () => {
    appendSalvageIndex(salvageRoot, {
      ts: '2026-01-01T00:00:00Z', pool: 'p', lane: 98, dir: null, stamp: '20260101-000001',
      outDir: join(salvageRoot, 'p', '20260101-000001'), // never created — nothing for the glob to find
      bundle: salvageRoot, // the tampered field — literally the root itself, not merely inside it
      patches: [], litter: [], reason: 'tampered', lastHolder: {}, branch: null, head: null,
      cards: [], prs: [], changedFiles: [], refs: [], localRefs: [], snapshots: [], landed: false,
    });
    writeFileSync(join(salvageRoot, 'sentinel.txt'), 'must survive\n');

    const victimDir = join(root, 'victim2');
    mkdirSync(victimDir, { recursive: true });
    const victim = join(victimDir, 'precious2.txt');
    writeFileSync(victim, 'not salvage content\n');
    const outDir = join(salvageRoot, 'p', '20260101-000002');
    mkdirSync(outDir, { recursive: true });
    symlinkSync(victimDir, join(outDir, 'lane-97.wt-litter')); // matches the glob prefix, but escapes via a symlink
    appendSalvageIndex(salvageRoot, {
      ts: '2026-01-01T00:00:00Z', pool: 'p', lane: 97, dir: null, stamp: '20260101-000002',
      outDir, bundle: null, patches: [], litter: [], reason: 'tampered', lastHolder: {}, branch: null, head: null,
      cards: [], prs: [], changedFiles: [], refs: [], localRefs: [], snapshots: [], landed: false,
    });

    const later = Date.parse('2026-01-01T00:00:00Z') + 15 * DAY;
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(r.expired).toHaveLength(2); // both rows still dropped from the index...
    expect(existsSync(salvageRoot)).toBe(true); // ...but the root itself is never `rmSync`-ed away
    expect(existsSync(join(salvageRoot, 'sentinel.txt'))).toBe(true);
    expect(existsSync(victim)).toBe(true); // ...and the symlink's OUT-OF-ROOT target survives untouched
  });

  it('#4273 review — containment resolves through a symlinked ANCESTOR: an outDir reached via a symlink that resolves outside the root is refused — the case a lexical-only check would wrongly approve', () => {
    const victimDir = join(root, 'victim4');
    mkdirSync(victimDir, { recursive: true });
    const victim = join(victimDir, 'lane-95.precious.txt'); // matches the `lane-${lane}.` glob prefix
    writeFileSync(victim, 'reached only by following a symlinked ancestor\n');
    mkdirSync(join(salvageRoot, 'p'), { recursive: true });
    const outDir = join(salvageRoot, 'p', '20260101-000004'); // LEXICALLY in-root...
    symlinkSync(victimDir, outDir); // ...but the directory ITSELF is a symlink to somewhere outside the root
    appendSalvageIndex(salvageRoot, {
      ts: '2026-01-01T00:00:00Z', pool: 'p', lane: 95, dir: null, stamp: '20260101-000004',
      outDir, bundle: null, patches: [], litter: [], reason: 'tampered', lastHolder: {}, branch: null, head: null,
      cards: [], prs: [], changedFiles: [], refs: [], localRefs: [], snapshots: [], landed: false,
    });
    const later = Date.parse('2026-01-01T00:00:00Z') + 15 * DAY;
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(r.expired).toHaveLength(1);
    expect(existsSync(victim)).toBe(true); // never deleted — realpath resolution caught the ancestor symlink
  });

  it('#4273 review — `bundle`/`patches` (the "plain" set) are removed NON-recursively: an in-root directory masquerading as `bundle` survives, rather than the whole tree being wiped', () => {
    const outDir = join(salvageRoot, 'p', '20260101-000003');
    mkdirSync(outDir, { recursive: true });
    const fakeBundleDir = join(outDir, 'not-really-a-bundle');
    mkdirSync(fakeBundleDir, { recursive: true });
    writeFileSync(join(fakeBundleDir, 'inner.txt'), 'must survive — bundle is never rmSync-ed recursively\n');
    appendSalvageIndex(salvageRoot, {
      ts: '2026-01-01T00:00:00Z', pool: 'p', lane: 96, dir: null, stamp: '20260101-000003',
      outDir, bundle: fakeBundleDir, // in-root, but a DIRECTORY where salvageLane always writes a plain file
      patches: [], litter: [], reason: 'tampered', lastHolder: {}, branch: null, head: null,
      cards: [], prs: [], changedFiles: [], refs: [], localRefs: [], snapshots: [], landed: false,
    });
    const later = Date.parse('2026-01-01T00:00:00Z') + 15 * DAY;
    const r = refreshSalvageIndex({ root: salvageRoot, nowMs: later });
    expect(r.expired).toHaveLength(1); // the row is still dropped from the index...
    expect(existsSync(join(fakeBundleDir, 'inner.txt'))).toBe(true); // ...but the "bundle" directory survives whole
  });

  it('backfills a hand-made salvage dir once (idempotent), deriving the PR from the last lease purpose', () => {
    writeFileSync(join(lane, 'a.txt'), 'manual\n');
    git(lane, 'update-ref', 'refs/salvage/lane-3-20260926-2136-head', 'HEAD');
    git(lane, 'stash', 'push', '-q');
    git(lane, 'update-ref', 'refs/salvage/lane-3-20260926-2136-wip', 'stash@{0}');
    const dir = join(salvageRoot, '20260926-2136');
    execFileSync('mkdir', ['-p', dir]);
    git(lane, 'bundle', 'create', join(dir, 'lane-3.bundle'), '--all');
    writeFileSync(join(dir, 'lane-3.uncommitted.patch'), 'diff --git a/a.txt b/a.txt\n');
    const args = { dir, pool: 'p', root: salvageRoot, laneDirFor: () => lane, readLastHolder: () => ({ purpose: 'ci-heal-2783' }) };
    const rows = backfillSalvageDir(args);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 3, prs: [2783], changedFiles: ['a.txt'], ts: '2026-09-26T21:36:00.000Z', backfilled: true });
    expect(rows[0].refs.sort()).toEqual(['refs/salvage/lane-3-20260926-2136-head', 'refs/salvage/lane-3-20260926-2136-wip']);
    expect(backfillSalvageDir(args)).toEqual([]);
    expect(readFileSync(join(salvageRoot, 'index.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('pool leftovers', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const old = now - 10 * DAY;
  const e = (o) => ({ isDir: false, isSymlink: false, isGit: false, newestMtimeMs: old, liveCwd: false, ...o });
  it('never touches lanes, dot-entries, symlinks, live or recent entries', () => {
    for (const x of [e({ name: 'lane-3', isDir: true }), e({ name: '.free-lanes.json' }), e({ name: 'webeverything', isSymlink: true }),
      e({ name: 'scratch', isDir: true, liveCwd: true }), e({ name: 'gate.log', newestMtimeMs: now - DAY })]) {
      expect(classifyPoolLeftover(x, { nowMs: now }).action).toBe('keep');
    }
  });
  it('indexes patches first, salvages stray clones first, deletes logs and scratch', () => {
    expect(classifyPoolLeftover(e({ name: 'port.patch' }), { nowMs: now }).action).toBe('index-then-delete');
    expect(classifyPoolLeftover(e({ name: 'verify-scratch-3383', isDir: true, isGit: true }), { nowMs: now }).action).toBe('salvage-then-delete');
    expect(classifyPoolLeftover(e({ name: 'cs-70.log' }), { nowMs: now }).action).toBe('delete');
    expect(classifyPoolLeftover(e({ name: 'lane-29-scratch', isDir: true }), { nowMs: now }).action).toBe('delete');
  });
});

describe('pool exhaustion', () => {
  const nowMs = Date.parse('2026-09-27T01:00:00Z');
  const fresh = new Date(nowMs - 60_000).toISOString();
  const lanes = [
    { lane: 1, path: '/p/lane-1', leased: true, lease: { acquiredAt: fresh, ownerSession: 'dead' } },
    { lane: 2, path: '/p/lane-2', leased: true, lease: { acquiredAt: fresh, ownerSession: 'alive' } },
    { lane: 3, path: '/p/lane-3', leased: false, clean: false },
    { lane: 4, path: '/p/lane-4', leased: false, clean: true },
  ];
  it('counts leases held by dead holders separately from dirty unleased lanes', () => {
    const s = summarizePoolExhaustion({ lanes, agents: [{ sessionId: 'alive', state: 'working' }], nowMs, ttlMs: 4 * 3600_000 });
    expect(s).toEqual({ total: 4, leased: 2, leasedStale: 0, leasedDeadHolder: 1, dirtyUnleased: 1, cleanUnleased: 1 });
    expect(formatPoolExhaustion('we', s, 5)).toMatch(/^pool exhausted: we — 0 acquirable of 4; 2 leased \(1 by dead holders, 0 TTL-stale\), 1 dirty unleased/);
  });
  it('logs once per episode and re-arms on recovery', () => {
    const lines = [];
    const logger = makePoolExhaustionLogger({ log: (l) => lines.push(l), readStatus: () => ({ lanes }), readAgents: () => null, nowMs: () => nowMs });
    expect(logger.exhausted({ repo: 'we', deferred: 3 })).toBe(true);
    expect(logger.exhausted({ repo: 'we', deferred: 3 })).toBe(false);
    logger.recovered('we');
    logger.exhausted({ repo: 'we', deferred: 1 });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\? \(claude agents unreadable\) by dead holders/);
  });
});

describe('health-watch salvage cores', () => {
  const rows = [
    { lane: 1, exists: true, verdict: 'finished-needs-review', lease: null },
    { lane: 2, exists: true, verdict: 'unknown-work', lease: null, kept: true },
    { lane: 3, exists: true, verdict: 'unknown-work', lease: { x: 1 } },
    { lane: 4, exists: true, verdict: 'in-use', lease: null },
    { lane: 5, exists: true, verdict: 'unknown-work', lease: null, lastHolder: { liveOwner: true } },
    { lane: 6, exists: true, verdict: 'finished-reclaimable', lease: null },
  ];
  it('only unleased, not-live, not-kept needs-review/unknown-work lanes are salvage candidates', () => {
    expect(planSalvageCandidates(rows).map((r) => r.lane)).toEqual([1]);
  });
  it('reclaim sub-pass calls plain reclaim for reclaimable lanes and --salvage for candidates, capped', () => {
    const calls = [];
    const out = reclaimFinishedLanes({ whois: { lanes: rows }, dryRun: true, salvageEnabled: true, salvageMax: 5, reclaimLane: (o) => { calls.push(o); return { wouldReclaim: true }; } });
    expect(calls).toEqual([{ lane: 6, dryRun: true }, { lane: 1, dryRun: true, salvage: true }]);
    expect(out[1]).toMatchObject({ lane: 1, salvageCandidate: true });
    expect(reclaimFinishedLanes({ whois: { lanes: rows }, dryRun: true, reclaimLane: () => ({}) })).toHaveLength(1);
  });
  it('raises the low-pool alert below the low-water mark only', () => {
    expect(lowPoolAlert({ acquirable: 0, total: 90, leased: 16, dirtyUnleased: 74 })).toMatch(/^ALERT: lane pool low — 0 acquirable \(< 5\) of 90: 16 leased, 74 dirty unleased/);
    expect(lowPoolAlert({ acquirable: 5, total: 90, leased: 0, dirtyUnleased: 0 })).toBeNull();
  });
});

it('suppresses real state with WE_UNDER_TEST alone', () => {
  expect(salvageHintFor({ cards: ['4229'], env: { WE_UNDER_TEST: '1' } })).toBe(null);
});
