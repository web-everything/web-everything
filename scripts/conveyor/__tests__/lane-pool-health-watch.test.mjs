/**
 * @file lane-pool-health-watch.test.mjs — `we:backlog/3568-*.md`'s periodic half. PURE logic tests for
 * `planLaneReap` / `summarizeHealth` + IO-shell tests over injected fakes (mirroring
 * `we:scripts/conveyor/__tests__/duplicate-pr-watch.test.mjs`'s own shape), plus a small real-git integration
 * check that a litter-only unleased lane is genuinely reaped on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanLaneLitter } from '../../lib/lane-litter.mjs';

import {
  DISABLE_ENV_VAR,
  formatSalvageKeptLine,
  planLaneReap,
  summarizeHealth,
  defaultListLaneStatus,
  defaultListAcquirable,
  defaultReclaimLane,
  defaultReadPorcelain,
  defaultIsLeasedNow,
  defaultIsLiveNow,
  defaultTrimPool,
  watchLanePoolHealth,
  runLanePoolHealthWatch,
  resolveLanePoolRepoPath,
  reclaimFinishedLanes,
} from '../lane-pool-health-watch.mjs';

describe('formatSalvageKeptLine', () => {
  it.each([
    [{ kept: true, keptReason: 'live agent', reason: 'fallback' }, 'live agent'],
    [{ kept: true, reason: 'fallback' }, 'fallback'],
    [{ kept: true }, 'unknown'],
  ])('prints the kept reason with existing fallback precedence: %j', (outcome, reason) => {
    expect(formatSalvageKeptLine(outcome)).toBe(reason);
  });
});

describe('planLaneReap — pure', () => {
  it('reaps an unleased lane whose entire porcelain output is allowlisted litter', () => {
    const plan = planLaneReap([
      { lane: 1, path: '/pool/lane-1', exists: true, leased: false, porcelain: '?? .commit-msg.txt\n?? .pr-body.md\n' },
    ]);
    expect(plan).toEqual([{ lane: 1, path: '/pool/lane-1', action: 'reap', toRemove: ['.commit-msg.txt', '.pr-body.md'] }]);
  });

  it('leaves a non-allowlisted dirty file untouched and reports it, even if litter sits alongside it', () => {
    const plan = planLaneReap([
      { lane: 2, path: '/pool/lane-2', exists: true, leased: false, porcelain: '?? .commit-msg.txt\n M file.txt\n' },
    ]);
    expect(plan).toEqual([{ lane: 2, path: '/pool/lane-2', action: 'leave-dirty', leaveDirty: ['file.txt'] }]);
  });

  it('never touches a LEASED lane, regardless of its dirty contents', () => {
    const plan = planLaneReap([
      { lane: 3, path: '/pool/lane-3', exists: true, leased: true, porcelain: '?? .commit-msg.txt\n M file.txt\n' },
    ]);
    expect(plan).toEqual([{ lane: 3, path: '/pool/lane-3', action: 'skip-leased' }]);
  });

  it('marks an already-clean unleased lane as already-clean, not reap', () => {
    const plan = planLaneReap([{ lane: 4, path: '/pool/lane-4', exists: true, leased: false, porcelain: '' }]);
    expect(plan).toEqual([{ lane: 4, path: '/pool/lane-4', action: 'already-clean' }]);
  });

  it('skips a lane index with no clone on disk', () => {
    expect(planLaneReap([{ lane: 5, exists: false }])).toEqual([]);
  });

  // #3568 — a failed porcelain read (`null`) must never read as clean.
  it('a lane whose porcelain read FAILED (null) is reported read-error, never already-clean/acquirable', () => {
    const plan = planLaneReap([{ lane: 6, path: '/pool/lane-6', exists: true, leased: false, porcelain: null }]);
    expect(plan).toEqual([{ lane: 6, path: '/pool/lane-6', action: 'read-error' }]);
  });

  it('an empty-string porcelain (genuinely clean) is NOT a read-error — still already-clean', () => {
    const plan = planLaneReap([{ lane: 7, path: '/pool/lane-7', exists: true, leased: false, porcelain: '' }]);
    expect(plan).toEqual([{ lane: 7, path: '/pool/lane-7', action: 'already-clean' }]);
  });

  it('tolerant of a null/undefined lanes list', () => {
    expect(planLaneReap(null)).toEqual([]);
    expect(planLaneReap(undefined)).toEqual([]);
  });
});

// #4344 — `reclaimFinishedLanes` re-reclaimed EVERY already-clean lane on EVERY pass (a full `reclaimLane`
// process tree apiece), because "finished-reclaimable" alone does not distinguish "already at rest" from
// "clean, but still behind the pool branch tip" (that second case still needs a real reclaim). These fixtures
// mirror the item's own 3-lane test plan: clean-at-tip (skip), clean-but-behind-tip (still reclaim), and
// dirty-unpreserved (never a candidate at all, unrelated to this fix).
describe('reclaimFinishedLanes — pure decision (#4344 already-clean skip)', () => {
  const wrap = (lanes) => ({ branch: 'origin/main', lanes });
  const recordingReclaim = (calls, result = { reclaimed: true }) => (o) => { calls.push(o); return result; };

  it('a lane with no uncommitted/ahead content, sitting AT the pool branch tip, is skipped — reported already-clean, reclaimLane never called', () => {
    const whois = wrap([{
      lane: 10, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([]);
    expect(outcomes).toEqual([{ lane: 10, reclaimed: false, alreadyClean: true, reason: 'already clean at the pool branch tip — nothing to reclaim' }]);
  });

  it('components that cancel to a zero sum (-2 + 2) at the tip still get a real reclaim call — never skipped as clean', () => {
    const whois = wrap([{
      lane: 12, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: -2, untracked: 2 }, ahead: { count: 0 },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([{ lane: 12, dryRun: false }]);
    expect(outcomes).toEqual([{ lane: 12, reclaimed: true }]);
  });

  it('a lane with no uncommitted/ahead content but BEHIND the tip still gets a real reclaim call — never silently skipped', () => {
    const whois = wrap([{
      lane: 11, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'old-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({
      whois, reclaimLane: recordingReclaim(calls, { reclaimed: true, preserved: true, reason: 'ok' }), dryRun: false,
    });
    expect(calls).toEqual([{ lane: 11, dryRun: false }]);
    expect(outcomes).toEqual([{ lane: 11, reclaimed: true, preserved: true, reason: 'ok' }]);
  });

  it('a dirty-unpreserved lane never becomes a candidate at all — its verdict already excludes it (unrelated to this fix)', () => {
    const whois = wrap([{
      lane: 12, exists: true, verdict: 'finished-needs-review',
      uncommitted: { trackedModified: 1, untracked: 0 }, ahead: { count: 0 },
      headSha: 'x', branchTipSha: 'x', branch: 'main',
    }]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  it('the item\'s own 3-lane fixture in one pass: clean-at-tip skipped, clean-behind-tip reclaimed, dirty-unpreserved untouched', () => {
    const whois = wrap([
      { lane: 10, exists: true, verdict: 'finished-reclaimable', uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 }, headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main' },
      { lane: 11, exists: true, verdict: 'finished-reclaimable', uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 }, headSha: 'old-sha', branchTipSha: 'tip-sha', branch: 'main' },
      { lane: 12, exists: true, verdict: 'finished-needs-review', uncommitted: { trackedModified: 1, untracked: 0 }, ahead: { count: 0 }, headSha: 'x', branchTipSha: 'x', branch: 'main' },
    ]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls.map((c) => c.lane)).toEqual([11]);
    expect(outcomes).toEqual([
      { lane: 10, reclaimed: false, alreadyClean: true, reason: 'already clean at the pool branch tip — nothing to reclaim' },
      { lane: 11, reclaimed: true },
    ]);
  });

  it('a clean lane at the right sha but on a STRAY branch still gets a real reclaim call (branch-name guard)', () => {
    const whois = wrap([{
      lane: 13, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'some-stray-branch',
    }]);
    const calls = [];
    reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([{ lane: 13, dryRun: false }]);
  });

  it('a second pass over the SAME lane after it was reclaimed makes zero reclaimLane calls — it is now already-clean', () => {
    const firstPass = wrap([{
      lane: 11, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'old-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls1 = [];
    reclaimFinishedLanes({ whois: firstPass, reclaimLane: recordingReclaim(calls1), dryRun: false });
    expect(calls1.length).toBe(1); // the reclaim actually ran

    // The next pass's whois re-reads this SAME lane fresh: the reclaim reset it, so HEAD now IS the tip.
    const secondPass = wrap([{
      lane: 11, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls2 = [];
    const outcomes2 = reclaimFinishedLanes({ whois: secondPass, reclaimLane: recordingReclaim(calls2), dryRun: false });
    expect(calls2).toEqual([]);
    expect(outcomes2).toEqual([{ lane: 11, reclaimed: false, alreadyClean: true, reason: 'already clean at the pool branch tip — nothing to reclaim' }]);
  });

  it('a missing/malformed whois.branch fails CLOSED — always reclaims, never skips on an unenforceable branch guard', () => {
    const whois = { lanes: [{
      lane: 14, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 0 },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }] }; // no top-level `branch` field at all
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([{ lane: 14, dryRun: false }]); // never silently skipped just because the guard can't run
    expect(outcomes).toEqual([{ lane: 14, reclaimed: true }]);
  });

  // #4344 review — `|| 0` on `row.uncommitted`/`row.ahead` would make "field missing" indistinguishable from
  // "field is zero", fail OPEN toward skipping a reclaim this predicate was never shown was safe on a
  // malformed/truncated row. This must fail CLOSED — same standard as the sha half, which already refuses a
  // missing headSha/branchTipSha.
  it('a row with `uncommitted`/`ahead` entirely MISSING (a malformed/truncated whois row) fails closed — always still reclaimed, never silently skipped', () => {
    const whois = wrap([{
      lane: 15, exists: true, verdict: 'finished-reclaimable',
      // no `uncommitted` / `ahead` at all — headSha/branchTipSha DO match, which is exactly the trap case
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls = [];
    const outcomes = reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([{ lane: 15, dryRun: false }]); // never treated as already-clean on malformed input
    expect(outcomes).toEqual([{ lane: 15, reclaimed: true }]);
  });

  it('a row whose `ahead.count` alone is non-numeric (malformed, not just absent) also fails closed', () => {
    const whois = wrap([{
      lane: 16, exists: true, verdict: 'finished-reclaimable',
      uncommitted: { trackedModified: 0, untracked: 0 }, ahead: { count: 'not-a-number' },
      headSha: 'tip-sha', branchTipSha: 'tip-sha', branch: 'main',
    }]);
    const calls = [];
    reclaimFinishedLanes({ whois, reclaimLane: recordingReclaim(calls), dryRun: false });
    expect(calls).toEqual([{ lane: 16, dryRun: false }]);
  });
});

describe('summarizeHealth — pure', () => {
  it('counts leased / acquirable / dirtyUnleased — a `reap` action counts as acquirable only when it actually succeeded', () => {
    const lanes = [
      { lane: 1, exists: true, leased: false },
      { lane: 2, exists: true, leased: false },
      { lane: 3, exists: true, leased: true },
      { lane: 4, exists: false },
    ];
    const plan = [
      { lane: 1, action: 'reap' },
      { lane: 2, action: 'leave-dirty' },
    ];
    expect(summarizeHealth(lanes, plan, [1])).toEqual({ total: 3, leased: 1, acquirable: 1, dirtyUnleased: 1 });
  });

  it('already-clean lanes are acquirable even with an empty `reaped` list', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'already-clean' }];
    expect(summarizeHealth(lanes, plan, [])).toEqual({ total: 1, leased: 0, acquirable: 1, dirtyUnleased: 0 });
  });

  // #3568 — a lane whose reap call THREW must not read as acquirable just
  // because the pre-execution plan said `'reap'` — it stayed dirty on disk, and the health line must say so.
  it('a `reap` action that did NOT actually succeed (missing from `reaped`) counts as dirtyUnleased, not acquirable', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'reap' }];
    expect(summarizeHealth(lanes, plan, [])).toEqual({ total: 1, leased: 0, acquirable: 0, dirtyUnleased: 1 });
  });

  it('defaults `reaped` to empty — a bare 2-arg call never optimistically counts a reap as done (e.g. a dry-run report)', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'reap' }];
    expect(summarizeHealth(lanes, plan)).toEqual({ total: 1, leased: 0, acquirable: 0, dirtyUnleased: 1 });
  });

  // #3383 — live-caught 2026-09-24: the plan alone never checks ahead-of-origin state, so a lane with a clean
  // working tree but real unpushed commits (the exact live false-positive: 11 of 14 lanes this file called
  // "acquirable" were really just clean-but-ahead) used to count as acquirable. The 4th arg is the REAL
  // `list --acquirable` answer (the same function `acquire`'s own auto-pick is built on) to cross-check
  // against, closing that divergence.
  describe('the 4th arg (real `list --acquirable` cross-check, #3383)', () => {
    it('omitted (null/undefined) — UNCHANGED plan-only behavior, for every existing caller', () => {
      const lanes = [{ lane: 1, exists: true, leased: false }, { lane: 2, exists: true, leased: false }];
      const plan = [{ lane: 1, action: 'already-clean' }, { lane: 2, action: 'already-clean' }];
      expect(summarizeHealth(lanes, plan, [])).toEqual({ total: 2, leased: 0, acquirable: 2, dirtyUnleased: 0 });
      expect(summarizeHealth(lanes, plan, [], null)).toEqual({ total: 2, leased: 0, acquirable: 2, dirtyUnleased: 0 });
    });

    it('a plan-clean lane the REAL answer excludes (clean-but-ahead) does NOT count as acquirable', () => {
      const lanes = [{ lane: 1, exists: true, leased: false }, { lane: 2, exists: true, leased: false }];
      const plan = [{ lane: 1, action: 'already-clean' }, { lane: 2, action: 'already-clean' }];
      // lane 1 is genuinely acquirable (real gate agrees); lane 2's porcelain is clean but it is really ahead
      // of origin — `list --acquirable` correctly excludes it, so this report must too.
      expect(summarizeHealth(lanes, plan, [], new Set([1]))).toEqual({ total: 2, leased: 0, acquirable: 1, dirtyUnleased: 1 });
    });

    it('the real answer can only NARROW the plan, never widen it — a plan-dirty lane never becomes acquirable', () => {
      const lanes = [{ lane: 1, exists: true, leased: false }];
      const plan = [{ lane: 1, action: 'leave-dirty', leaveDirty: ['file.txt'] }];
      // Even if the real read (implausibly) named lane 1 acquirable, real dirt in the plan still wins.
      expect(summarizeHealth(lanes, plan, [], new Set([1]))).toEqual({ total: 1, leased: 0, acquirable: 0, dirtyUnleased: 1 });
    });
  });
});

describe('defaultListLaneStatus — argv shape (exec injected, no real subprocess)', () => {
  it('shells lane-pool.mjs status --json with no --repo when omitted', () => {
    let capturedCmd; let capturedArgv; let capturedOpts;
    const exec = (cmd, argv, opts) => { capturedCmd = cmd; capturedArgv = argv; capturedOpts = opts; return '{"repo":"web-everything","root":"/pool/web-everything","lanes":[]}'; };
    const out = defaultListLaneStatus({ exec, root: '/repo' });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json']);
    expect(capturedOpts.cwd).toBe('/repo');
    expect(out).toEqual({ repo: 'web-everything', root: '/pool/web-everything', lanes: [] });
  });

  it('appends --repo when given a raw path, unchanged', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: '/some/checkout' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json', '--repo=/some/checkout']);
  });

  // Live-caught 2026-09-22 (#3873's own first real daemon run, non-dry-run): a caller passing a SLUG — the
  // same convention every sibling repo-generic pass accepts — crashed every run, because this file forwarded
  // it unchanged into lane-pool.mjs's own PATH-only --repo flag.
  it('resolves a constellation SLUG to its real checkout path before shelling lane-pool.mjs', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: 'plateauapp/plateau-app' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json', `--repo=${process.env.HOME}/workspace/plateau-app`]);
  });

  it('a WE slug appends NO --repo at all — WE has no fixed path, lane-pool.mjs defaults to the cwd toplevel', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: 'web-everything/web-everything' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json']);
  });
});

// #3383 — the REAL eligibility read `summarizeHealth` cross-checks its plan-only classification against.
describe('defaultListAcquirable — argv shape (exec injected, no real subprocess)', () => {
  it('shells lane-pool.mjs list --acquirable --json with no --repo when omitted, and returns a Set of lane numbers', () => {
    let capturedCmd; let capturedArgv; let capturedOpts;
    const exec = (cmd, argv, opts) => {
      capturedCmd = cmd; capturedArgv = argv; capturedOpts = opts;
      return JSON.stringify(['/pool/web-everything/lane-3', '/pool/web-everything/lane-11']);
    };
    const out = defaultListAcquirable({ exec, root: '/repo' });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'list', '--acquirable', '--json']);
    expect(capturedOpts.cwd).toBe('/repo');
    expect(out).toEqual(new Set([3, 11]));
  });

  it('resolves a constellation slug the same way defaultListLaneStatus does', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '[]'; };
    defaultListAcquirable({ exec, root: '/repo', repo: 'plateauapp/plateau-app' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'list', '--acquirable', '--json', `--repo=${process.env.HOME}/workspace/plateau-app`]);
  });

  it('returns null (never throws) when the child fails', () => {
    const exec = () => { throw new Error('boom'); };
    expect(defaultListAcquirable({ exec })).toBeNull();
  });

  it('returns null on unparsable JSON, rather than throwing', () => {
    const exec = () => 'not json';
    expect(defaultListAcquirable({ exec })).toBeNull();
  });

  it('returns null when the parsed output is not an array', () => {
    const exec = () => '{"not":"an array"}';
    expect(defaultListAcquirable({ exec })).toBeNull();
  });
});

describe('resolveLanePoolRepoPath', () => {
  it('a recognized slug resolves to that repo\'s real checkout path, $HOME expanded', () => {
    expect(resolveLanePoolRepoPath('plateauapp/plateau-app', '/Users/x')).toBe('/Users/x/workspace/plateau-app');
    expect(resolveLanePoolRepoPath('frontier-ui/frontierui', '/Users/x')).toBe('/Users/x/workspace/frontierui');
  });
  it('the WE slug resolves to null (no fixed path — let lane-pool.mjs default to the cwd toplevel)', () => {
    expect(resolveLanePoolRepoPath('web-everything/web-everything', '/Users/x')).toBeNull();
  });
  it('an unrecognized value (already a path) passes through unchanged', () => {
    expect(resolveLanePoolRepoPath('/some/checkout', '/Users/x')).toBe('/some/checkout');
  });
  it('null/empty passes through as null', () => {
    expect(resolveLanePoolRepoPath(null)).toBeNull();
    expect(resolveLanePoolRepoPath('')).toBeNull();
  });
});

describe('defaultReadPorcelain', () => {
  it('returns the raw exec output', () => {
    const exec = () => '?? foo.txt\n';
    expect(defaultReadPorcelain('/lane-1', exec)).toBe('?? foo.txt\n');
  });
  it('returns null (not throw) on a git failure', () => {
    const exec = () => { throw new Error('not a git repo'); };
    expect(defaultReadPorcelain('/gone', exec)).toBeNull();
  });
});

// #4025 — the periodic SHRINK half wired in beside the existing periodic litter-reap pass.
describe('defaultTrimPool — argv shape (exec injected, no real subprocess)', () => {
  it('shells lane-pool.mjs trim --json with no --repo/--max/--dry-run when omitted', () => {
    let capturedCmd; let capturedArgv; let capturedOpts;
    const exec = (cmd, argv, opts) => { capturedCmd = cmd; capturedArgv = argv; capturedOpts = opts; return '{"repo":"web-everything","total":5,"max":60,"removed":[],"kept":[],"remaining":5,"overCap":0,"dryRun":false}'; };
    const out = defaultTrimPool({ exec, root: '/repo' });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json']);
    expect(capturedOpts.cwd).toBe('/repo');
    expect(out).toEqual({ repo: 'web-everything', total: 5, max: 60, removed: [], kept: [], remaining: 5, overCap: 0, dryRun: false });
  });

  it('appends --repo, --max, --dry-run when given', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{}'; };
    defaultTrimPool({ exec, root: '/repo', repo: '/some/checkout', max: 20, dryRun: true });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json', '--repo=/some/checkout', '--max=20', '--dry-run']);
  });

  it('resolves a constellation slug the same way defaultListLaneStatus does', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{}'; };
    defaultTrimPool({ exec, root: '/repo', repo: 'plateauapp/plateau-app' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json', `--repo=${process.env.HOME}/workspace/plateau-app`]);
  });

  it('returns null (never throws) when the child fails', () => {
    const exec = () => { throw new Error('boom'); };
    expect(defaultTrimPool({ exec })).toBeNull();
  });

  it('returns null on unparsable JSON, rather than throwing', () => {
    const exec = () => 'not json';
    expect(defaultTrimPool({ exec })).toBeNull();
  });
});

describe('watchLanePoolHealth — IO shell over injected fakes', () => {
  it('reaps every unleased litter-only lane and reports the health line', () => {
    const listStatus = () => ({
      repo: 'web-everything',
      root: '/pool/web-everything',
      lanes: [
        { lane: 1, path: '/pool/web-everything/lane-1', exists: true, leased: false, clean: false },
        { lane: 2, path: '/pool/web-everything/lane-2', exists: true, leased: true, clean: false },
        { lane: 3, path: '/pool/web-everything/lane-3', exists: true, leased: false, clean: true },
      ],
    });
    const porcelains = { '/pool/web-everything/lane-1': '?? .commit-msg.txt\n' };
    const readPorcelain = (dir) => porcelains[dir] ?? '';
    const reapedDirs = [];
    const reap = (dir) => { reapedDirs.push(dir); return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.plan.find((p) => p.lane === 1)).toEqual({ lane: 1, path: '/pool/web-everything/lane-1', action: 'reap', toRemove: ['.commit-msg.txt'] });
    expect(result.plan.find((p) => p.lane === 2)).toEqual({ lane: 2, path: '/pool/web-everything/lane-2', action: 'skip-leased' });
    expect(result.plan.find((p) => p.lane === 3)).toEqual({ lane: 3, path: '/pool/web-everything/lane-3', action: 'already-clean' });
    expect(reapedDirs).toEqual(['/pool/web-everything/lane-1']);
    expect(result.reaped).toEqual([1]);
    expect(result.health).toEqual({ total: 3, leased: 1, acquirable: 2, dirtyUnleased: 0 });
  });

  // #3383 — end-to-end proof of the wiring: `listAcquirable` is called (after the litter-reap, with the
  // same repo/root this pass was given) and its answer narrows the plan-only count — lane 3 here looks
  // plan-clean (porcelain has no litter) but the REAL `list --acquirable` answer excludes it (e.g. it is
  // really ahead of origin), so it must NOT be reported acquirable even though its plan action is clean.
  it('narrows the acquirable count by the real list --acquirable answer, and forwards repo/root to it', () => {
    const listStatus = () => ({
      lanes: [
        { lane: 1, path: '/pool/web-everything/lane-1', exists: true, leased: false },
        { lane: 3, path: '/pool/web-everything/lane-3', exists: true, leased: false },
      ],
    });
    const readPorcelain = () => '';
    let capturedListAcquirableArgs;
    const listAcquirable = (o) => { capturedListAcquirableArgs = o; return new Set([1]); }; // lane 3 excluded
    const result = watchLanePoolHealth({
      listStatus, readPorcelain, reap: () => {}, trimPool: () => null, listAcquirable, listWhois: () => null,
      repo: 'plateauapp/plateau-app', root: '/repo',
    });
    expect(capturedListAcquirableArgs).toEqual({ repo: 'plateauapp/plateau-app', root: '/repo' });
    expect(result.plan.find((p) => p.lane === 1).action).toBe('already-clean');
    expect(result.plan.find((p) => p.lane === 3).action).toBe('already-clean'); // plan alone still says clean
    expect(result.health).toEqual({ total: 2, leased: 0, acquirable: 1, dirtyUnleased: 1 }); // real answer wins
  });

  it('never reads a LEASED lane\'s porcelain at all', () => {
    const listStatus = () => ({
      lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: true, clean: false }],
    });
    let readCalled = false;
    const readPorcelain = () => { readCalled = true; return '?? .commit-msg.txt\n'; };
    watchLanePoolHealth({ listStatus, readPorcelain, reap: () => {}, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(readCalled).toBe(false);
  });

  it('dry-run plans but never reaps', () => {
    const listStatus = () => ({
      lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }],
    });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    let reapCalled = false;
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap: () => { reapCalled = true; }, dryRun: true, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(reapCalled).toBe(false);
    expect(result.reaped).toEqual([]);
    expect(result.plan[0].action).toBe('reap');
    expect(result.dryRun).toBe(true);
  });

  it('one lane\'s reap failure does not stop the sweep from reaping the rest', () => {
    const listStatus = () => ({
      lanes: [
        { lane: 1, path: '/pool/lane-1', exists: true, leased: false },
        { lane: 2, path: '/pool/lane-2', exists: true, leased: false },
      ],
    });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const reap = (dir) => {
      if (dir === '/pool/lane-1') throw new Error('boom');
      return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true };
    };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.reaped).toEqual([2]);
  });

  // #xl5xhmj fork 2 — the litter-reap pass must gate on LIVE OWNERSHIP, not just the lease, so it never
  // deletes a live worker's own scratch files just because the lane read unleased.
  it('forwards isLeasedNow AND isLiveNow into every reap call, defaulting to defaultIsLeasedNow/defaultIsLiveNow', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    let captured;
    const reap = (dir, opts) => { captured = opts; return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; };
    watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(captured.isLeasedNow).toBe(defaultIsLeasedNow);
    expect(captured.isLiveNow).toBe(defaultIsLiveNow);
  });

  it('a custom isLiveNow reaching `true` is honored by the injected reap fake — the pass never second-guesses it', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const isLiveNow = (dir) => dir === '/pool/lane-1'; // a live worker is sitting in this exact lane
    const reap = (dir, opts) => (opts.isLiveNow(dir)
      ? { removed: [], leaveDirty: [], skipped: true, complete: false }
      : { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true });
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, isLiveNow, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.reaped).toEqual([]); // gated live — nothing counted as reaped
  });
});

// #4025 — the trim wiring: watchLanePoolHealth calls trimPool once, forwards repo/root/max/dryRun, and merges
// its result onto `.trim`, all independent of whatever the litter-reap half above did that tick.
describe('watchLanePoolHealth — trim wiring (#4025)', () => {
  it('calls trimPool with repo/root/max/dryRun and merges its result onto .trim', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return { total: 10, max: 5, removed: [9, 10], kept: [], remaining: 8, overCap: 3, dryRun: false }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain: () => '', repo: 'plateauapp/plateau-app', root: '/repo', trimMax: 5, trimPool, listAcquirable: () => null, listWhois: () => null });
    expect(captured).toEqual({ repo: 'plateauapp/plateau-app', root: '/repo', max: 5, dryRun: false });
    expect(result.trim).toEqual({ total: 10, max: 5, removed: [9, 10], kept: [], remaining: 8, overCap: 3, dryRun: false });
  });

  it('forwards dryRun into trimPool too — a dry-run health-watch tick never lets trim actually remove anything', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return null; };
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', dryRun: true, trimPool, listAcquirable: () => null, listWhois: () => null });
    expect(captured.dryRun).toBe(true);
  });

  it('a null trim result (best-effort failure) is reported as .trim: null, never thrown', () => {
    const listStatus = () => ({ lanes: [] });
    const result = watchLanePoolHealth({ listStatus, readPorcelain: () => '', trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.trim).toBeNull();
  });

  it('defaults trimMax to null when omitted — trim falls back to its own per-repo cap', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return null; };
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', trimPool, listAcquirable: () => null, listWhois: () => null });
    expect(captured.max).toBeNull();
  });
});

describe('runLanePoolHealthWatch — the entrypoint', () => {
  it(`${DISABLE_ENV_VAR} set to any value makes it a true no-op — no read, no reap, no report`, () => {
    let listStatusCalled = false;
    const listStatus = () => { listStatusCalled = true; return { lanes: [] }; };
    const result = runLanePoolHealthWatch({ env: { [DISABLE_ENV_VAR]: '1' }, listStatus });
    expect(result).toEqual({ disabled: true });
    expect(listStatusCalled).toBe(false);
  });

  it('runs normally when the env var is absent', () => {
    const listStatus = () => ({ lanes: [] });
    const result = runLanePoolHealthWatch({ env: {}, listStatus, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.disabled).toBeUndefined();
    expect(result.health).toEqual({ total: 0, leased: 0, acquirable: 0, dirtyUnleased: 0 });
  });

  // #3568 — "presence-checked, any value" must include an
  // EMPTY string, which a bare truthiness check on `env[DISABLE_ENV_VAR]` would treat as unset.
  it(`${DISABLE_ENV_VAR}='' (empty string) still disables — presence, not truthiness`, () => {
    let listStatusCalled = false;
    const listStatus = () => { listStatusCalled = true; return { lanes: [] }; };
    const result = runLanePoolHealthWatch({ env: { [DISABLE_ENV_VAR]: '' }, listStatus });
    expect(result).toEqual({ disabled: true });
    expect(listStatusCalled).toBe(false);
  });
});

describe('watchLanePoolHealth — TOCTOU guard (#3568)', () => {
  // `isLeasedNow`/`isLiveNow` are now passed straight INTO `reap` (`cleanLaneLitter`'s own last-gate checks),
  // never checked separately by this function beforehand — see `cleanLaneLitter`'s own docblock for why. This
  // describe block pins the PASS-THROUGH contract; `cleanLaneLitter`'s own real behavior for both is pinned in
  // `we:scripts/lib/__tests__/lane-litter.test.mjs`.
  it('passes isLeasedNow straight into reap, for every action:"reap" lane (alongside the default isLiveNow, #xl5xhmj)', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const isLeasedNow = () => false;
    let capturedArgs;
    const reap = (path, opts) => { capturedArgs = [path, opts]; return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, isLeasedNow, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(capturedArgs).toEqual(['/pool/lane-1', { isLeasedNow, isLiveNow: defaultIsLiveNow }]);
    expect(result.reaped).toEqual([1]);
  });

  it('a skipped outcome (reap declined — leased or real dirt raced in) is not counted as reaped', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const reap = () => ({ removed: [], leaveDirty: [], skipped: true, complete: false });
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(result.reaped).toEqual([]);
    // still PLANNED as 'reap' (the plan is a snapshot decision) — only the actual mutation was declined
    expect(result.plan[0].action).toBe('reap');
  });

  it('reap is never even called for a lane the plan did not mark for reap (already-clean)', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    let called = false;
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', reap: () => { called = true; }, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });
    expect(called).toBe(false);
  });

  it('counts a lane as reaped when reap succeeds (skipped:false)', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    let reapCalled = false;
    const result = watchLanePoolHealth({
      listStatus, readPorcelain, reap: () => { reapCalled = true; return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; },
      trimPool: () => null, listAcquirable: () => null, listWhois: () => null,
    });
    expect(reapCalled).toBe(true);
    expect(result.reaped).toEqual([1]);
  });
});

describe('defaultIsLeasedNow — real lease-marker read', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-lease-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('false when no marker exists', () => {
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });

  it('true for a fresh, live lease marker', () => {
    writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ session: 's', acquiredAt: new Date().toISOString() }));
    expect(defaultIsLeasedNow(dir)).toBe(true);
  });

  it('false for a TTL-expired (stale) lease marker — a dead holder is not a lease', () => {
    const acquiredAt = new Date(Date.now() - 10 * 864e5).toISOString(); // 10 days ago
    writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ session: 's', acquiredAt }));
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });

  it('false (fail-open) for a corrupt marker', () => {
    writeFileSync(join(dir, '.git', '.lane-lease'), 'not json');
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });
});

// #xl5xhmj — `defaultIsLiveNow`'s OWN behavior, not just its identity. Every existing reference to it
// (`toBe(defaultIsLiveNow)` above, or a caller-supplied fake standing in for it) exercises no production code
// inside its body: neither its fail-closed `catch { return true }` nor its `!eligible` inversion of the real
// gate. A flipped catch (`return false`) or a dropped `!` would pass the whole suite unchanged before these
// tests existed. Faked `claude`/`lsof` on PATH (same technique `lane-pool-reclaim.test.mjs` uses) + a zeroed
// quiet period make the REAL `laneLivenessGate` this function calls behave deterministically, without this
// unit test depending on the real host's own live sessions/processes.
describe('defaultIsLiveNow — real gate behavior, not just identity (#xl5xhmj)', () => {
  let dir;
  let binDir;
  let prevPath;
  let prevQuiet;

  const fakeExe = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, script);
    chmodSync(p, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-livenow-'));
    execFileSync('git', ['init', '--quiet'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    writeFileSync(join(dir, 'file.txt'), 'v1\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: dir });
    execFileSync('git', ['commit', '--quiet', '-m', 'v1'], { cwd: dir });

    binDir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-livenow-bin-'));
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath}`;
    // The gate's quiet-period half defaults to 30 minutes — zeroed here so a lane this test JUST wrote reads as
    // quiet immediately (the real 30-minute default gets its OWN dedicated end-to-end coverage in
    // `we:scripts/__tests__/lane-pool-reclaim.test.mjs`, through `cmdReclaim`, not here).
    prevQuiet = process.env.WE_LANE_SALVAGE_QUIET_MIN;
    process.env.WE_LANE_SALVAGE_QUIET_MIN = '0';
    fakeExe('lsof', '#!/bin/sh\nexit 0\n');
  });

  afterEach(() => {
    process.env.PATH = prevPath;
    if (prevQuiet === undefined) delete process.env.WE_LANE_SALVAGE_QUIET_MIN;
    else process.env.WE_LANE_SALVAGE_QUIET_MIN = prevQuiet;
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it('inverts a genuinely-eligible gate (quiet, no live owner/pid) to NOT live', () => {
    fakeExe('claude', "#!/bin/sh\necho '[]'\n");
    expect(defaultIsLiveNow(dir)).toBe(false);
  });

  it('inverts an ineligible gate (a live owner session in this lane) to LIVE', () => {
    fakeExe('claude', `#!/bin/sh\necho '[{"sessionId":"s","state":"working","cwd":"${dir}"}]'\n`);
    expect(defaultIsLiveNow(dir)).toBe(true);
  });

  it('fails CLOSED (still "live") when the underlying read throws, never toward "safe to reap"', () => {
    // A non-string dir makes `readLaneHistory`'s own `join(dir, ...)` throw synchronously, hitting
    // `defaultIsLiveNow`'s own try/catch (its docblock's fail-closed promise) rather than any of
    // `laneLivenessGate`'s internal, already-caught failure paths.
    expect(defaultIsLiveNow(undefined)).toBe(true);
  });

  // Red-team finding — every OTHER test either exercises `defaultIsLiveNow` directly (above) or wires a FAKE
  // `isLiveNow` into `cleanLaneLitter` (`lane-litter.test.mjs`) — none combines the REAL `defaultIsLiveNow`
  // with REAL litter on disk through the REAL `cleanLaneLitter`, the exact composition the litter-reap pass
  // actually runs in production.
  it('the REAL defaultIsLiveNow, wired into the REAL cleanLaneLitter, refuses to reap a lane a live agent is sitting in', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
    fakeExe('claude', `#!/bin/sh\necho '[{"sessionId":"s","state":"working","cwd":"${dir}"}]'\n`);
    const result = cleanLaneLitter(dir, { isLiveNow: defaultIsLiveNow });
    expect(result).toEqual({ removed: [], leaveDirty: [], skipped: true, complete: false });
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true);
  });

  it('the REAL defaultIsLiveNow, wired into the REAL cleanLaneLitter, reaps normally once no one is home', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
    fakeExe('claude', "#!/bin/sh\necho '[]'\n");
    const result = cleanLaneLitter(dir, { isLiveNow: defaultIsLiveNow });
    expect(result).toEqual({ removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true });
  });
});

// ── Real-git integration: the same shared `cleanLaneLitter` core actually reaps on disk ──────────────────────
describe('watchLanePoolHealth — real git integration (proves the SAME shared cleanup fn is reused, not re-derived)', () => {
  let dir;
  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-'));
    git(['init', '--quiet'], dir);
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'file.txt'), 'v1\n');
    git(['add', 'file.txt'], dir);
    git(['commit', '--quiet', '-m', 'v1'], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a real litter-only unleased lane on disk via the shared cleanLaneLitter core', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'WE #1: test\n');
    writeFileSync(join(dir, 'review-3568-output.json'), '{}\n');

    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    // #xl5xhmj — `isLiveNow` now defaults to the REAL `defaultIsLiveNow` (real `claude agents --json` + `lsof`
    // + a 30-minute quiet period), which this in-process unit test has no business depending on — a file this
    // test JUST wrote reads as "not quiet yet" against the real clock. Faked false here (this test is about the
    // shared `cleanLaneLitter` core, not the liveness gate — that gate has its own dedicated coverage).
    const result = watchLanePoolHealth({ listStatus, readPorcelain: defaultReadPorcelain, isLiveNow: () => false, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });

    expect(result.reaped).toEqual([1]);
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(false);
    expect(existsSync(join(dir, 'review-3568-output.json'))).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });

  it('leaves a real non-allowlisted dirty file on disk, reported not reaped', () => {
    writeFileSync(join(dir, 'notes.txt'), 'not on the allowlist\n');
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');

    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    const result = watchLanePoolHealth({ listStatus, readPorcelain: defaultReadPorcelain, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });

    expect(result.reaped).toEqual([]);
    expect(result.plan[0].action).toBe('leave-dirty');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true); // never partially reaped alongside real dirt
  });

  // #3568 — proved end-to-end: real dirt written AFTER the plan snapshot
  // but BEFORE the mutation must cancel the reap, via `cleanLaneLitter`'s own leaveDirty gate (armed whenever
  // `isLeasedNow` is passed) over its one fresh read — not a stale plan decision.
  it('a race — real dirt appears on disk between the snapshot and the reap call — cancels the reap, litter included', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
    // The plan is built from THIS snapshot (pure litter) — but the injected `readPorcelain` simulates a
    // concurrent write landing on disk between the snapshot and the actual `reap()` call by writing the real
    // file itself at snapshot time, i.e. by the time `reap` (real `cleanLaneLitter`) takes its OWN fresh read,
    // the race has already "happened" on disk.
    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    const readPorcelain = (d) => {
      const snapshot = defaultReadPorcelain(d);
      writeFileSync(join(dir, 'raced-in.txt'), 'a concurrent real edit\n'); // lands after the snapshot is taken
      return snapshot;
    };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, trimPool: () => null, listAcquirable: () => null, listWhois: () => null });

    expect(result.plan[0].action).toBe('reap'); // the STALE plan still says reap — it saw only litter
    expect(result.reaped).toEqual([]); // but the actual mutation was cancelled by the fresh re-read
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true); // litter left in place too — never partial
    expect(existsSync(join(dir, 'raced-in.txt'))).toBe(true);
  });
});


describe('low-pool preserved recovery', () => {
  it.each([false, true])('uses plain reclaim for preserved unleased lanes, leaving unpreserved and owned lanes (dryRun=%s)', (dryRun) => {
    const rows = [
      { lane: 1, preserved: true },
      { lane: 2, preserved: false },
      { lane: 3, preserved: true, lease: { session: 'current' } },
      { lane: 4, preserved: true, liveOwner: true },
      { lane: 5, preserved: true, kept: true },
    ].map((r) => ({ exists: true, verdict: 'unknown-work', ...r }));
    const calls = [];
    const result = runLanePoolHealthWatch({
      env: {}, dryRun, lowWater: 2,
      listStatus: () => ({ lanes: rows.map((r) => ({ lane: r.lane, path: `/pool/lane-${r.lane}`, exists: true, leased: !!r.lease })) }),
      readPorcelain: () => ' M work.txt\n', trimPool: () => null,
      listAcquirable: () => new Set(), writeFreeLaneList: () => null,
      listWhois: () => ({ lanes: rows }),
      reclaimLane: (o) => { calls.push(o); return dryRun ? { wouldReclaim: true } : { reclaimed: true }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ lane: 1, dryRun });
    expect(calls[0]).not.toHaveProperty('salvage');
    expect(calls[0]).not.toHaveProperty('override');
    expect(result.reclaim.outcomes).toEqual([{ lane: 1, ...(dryRun ? { wouldReclaim: true } : { reclaimed: true }) }]);
    expect(result.alert).toMatch(/ALERT/);
  });

  it('does not broaden selection when the pool is above the low-water threshold', () => {
    const calls = [];
    reclaimFinishedLanes({ whois: { lanes: [{ lane: 1, exists: true, preserved: true, verdict: 'unknown-work' }] },
      reclaimLane: (o) => calls.push(o), dryRun: false, reclaimPreserved: false });
    expect(calls).toEqual([]);
  });

  it('the recovery child uses the safe reclaim command', () => {
    let argv;
    defaultReclaimLane({ lane: 14, exec: (_cmd, args) => { argv = args; return '{"reclaimed":true}'; } });
    expect(argv).toContain('reclaim');
    expect(argv).toContain('--lane=14');
    expect(argv).not.toContain('--override');
    expect(argv).not.toContain('--salvage');
  });
});
